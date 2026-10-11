# dsh-tally Remote API 与参考界面（计划 3/4）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `dsh-tally` 加上浏览器可调用的 Remote API 命名空间 `tally`，新增参考界面包 `dsh-tally-ui`（费用条、每轮费用、会话累计、用量看板、设置页、预算提醒），并补齐计划 1、2 留下的后端事项：会话删除标记、价格覆盖可在设置页编辑、预算文件跨进程加锁、余额首次失败后的重试和错误代码。

**Architecture:**
- **Host 端**：`dsh-tally` 新增一个 `TypertRemoteService`（服务名 `tallyRemote`，命名空间 `tally`），用标准装饰器 `@Remote` 标注方法。dsh 的事件转发白名单不对第三方开放，所以服务端事件通过流式方法 `watch` 推送。
- **浏览器端接口描述**：手写一份带严格 zod 编解码器的 `TypertRemoteContribution`，放在 `packages/tally/src/remote/contract.ts`，通过子路径 `dsh-tally/remote` 导出。Host 端用同一套 zod schema 校验请求参数。
- **`dsh-tally-ui`**：一个 Host 端几乎为空、只带浏览器代码的插件包。浏览器代码用 tsdown 打包成 dsh 的客户端模块格式（`window.__ModuleLoader__.load`），启动时用 `ctx.remote.$mount()` 挂载 `tally` 命名空间，再把 React 组件注册到官方 slot。

**Tech Stack:** 与计划 1、2 相同。新增：
- 运行时：`zod@^4.4.3`（`dsh-tally` 的 dependency）、`@deepseek-ai/dsh-typert-protocol`、`@deepseek-ai/dsh-atomic-write`（peer 加 dev）；
- 浏览器端：React 18（`react ^18.2`、`@types/react ~18.3.1`），打包用 `tsdown@0.23.1`；
- 测试：`jsdom`、`@testing-library/react`、`@deepseek-ai/dsh-client-test-runtime@0.2.0-rc.2`、`@deepseek-ai/dsh-typert-registry@0.2.0-rc.2`、`@deepseek-ai/dsh-api-gateway@0.2.0-rc.2`，以及 `playwright`（版本与 `/opt/pw-browsers` 里的 chromium 修订号 1194 匹配，即 1.56.x；不要运行 `playwright install`）。

**Spec:** `docs/superpowers/specs/2026-10-10-dsh-tally-design.md`（§5.3 Remote API 的实现方式、§5.6 参考界面，均含 2026-10-11 修订）

**前置条件:** 计划 1、2 已完成（PR wfengq/dsh#1）。本计划在同一分支上继续开发。

**官方参考（只读）：** dsh 源码副本在会话 scratchpad 的 `src/deepseek-ai_deepseek-harness`（下文记作 `$DSH_SRC`），版本比安装的 0.2.0-rc.2 稍新，结论以 `node_modules` 里安装的 `.d.ts` 为准。常用参考：
- `$DSH_SRC/docs/cookbook/adding-a-remote-api.md`、`$DSH_SRC/docs/api-gateway.md`；
- `$DSH_SRC/packages/experimental/api-speech-to-text`（第三方式命名空间的 Host 端）和 `$DSH_SRC/packages/experimental/client-ui-voice-input/src/client/{index,mount}.ts`（浏览器端 `$mount`）；
- `$DSH_SRC/packages/client/tsdown.client.ts`（官方客户端打包配置）；
- `$DSH_SRC/packages/session-query/session-log-export`（会话头部按钮的完整模板）、`$DSH_SRC/packages/client/ui-plan`（turnTail 和右侧栏 tab）、`$DSH_SRC/packages/client/ui-settings-session-log`（设置项读写和 `shell.overlay` 提示）；
- `$DSH_SRC/apps/web/tests/smoke-real.e2e.ts`（真实 dsh web 的启动方式）。

## Global Constraints

- 包名：`dsh-tally-ui`，目录 `packages/tally-ui`，Loader 条目 id `tally-ui`。Remote 命名空间固定为 `tally`，Host 服务名 `tallyRemote`。`dsh-tally` 的条目 id 仍是 `tally`。
- 包约定与计划 1、2 相同：`"type": "module"`；`engines.node` 为 `">=22.19.0"`；MIT 协议，`files` 中包含 `LICENSE`；peer 依赖范围为 `@deepseek-ai/cordis` `">=4.0.4-0 <4.1.0-0"`、`@deepseek-ai/schemastery` `">=3.18.4-0 <3.19.0-0"`、`@deepseek-ai/dsh-*` `">=0.2.0-0 <0.3.0-0"`；dev 依赖固定为 `4.0.4` / `3.18.4` / `0.2.0-rc.2`。
- 金额一律是十进制字符串，浏览器端格式化也只用字符串运算，**禁止浮点数**（比例类数值如缓存命中率除外，它不是金额）。没有价格时显示“未定价”，**不显示 0**；余额查询失败时显示上一次的值并标注“已过期”，从未成功过时显示错误原因，**不显示 0**。
- `dsh-tally`、`dsh-tally-ui` 都不得读凭据、不得发起网络请求（浏览器端只走同源 Remote API）；dsh-trust-check 对二者都不得有红线。
- 浏览器 bundle 只允许 `require()` 宿主共享模块表里的模块：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`。其余（包括 zod、`dsh-tally/remote`、自己的代码和 CSS）全部内联。
- 界面样式只用 `--dsw-alias-*` 语义变量和 `--dsw-elevation-*`，不写主题选择器，不写字面颜色值。文案只放在 `zh`、`en` 两个字典里（包括 aria 标签），两种语言的键必须完全一致。
- Remote 方法的参数是单个 `request` 对象（无参方法除外），参数名不得叫 `agent` 或 `session`。参数在 Host 端用 `contract.ts` 里的同一份 zod schema 校验，失败时抛 `RemoteError('gateway/bad-request', …)`。
- 预算提醒、余额刷新、记账口径等计划 2 的约束继续有效；本计划不改变任何已存数据的格式（`budgets.json` 仍为 `version: 1`，数据库仍为 `user_version = 1`）。
- 代码标识符和注释用英文，面向用户的文档和界面文案用中文（另附英文字典）。

## Review Focus

1. **浏览器断线重连**（dsh 重启、网络抖动）：`watch` 流重新打开后，界面要用新的 `hello` 帧整体刷新，不能停在旧数据，也不能把重连前后的 `recorded` 帧重复累加（Task 3、Task 6 有测试）。
2. **大额、小额和多币种金额的显示**：`0.000001`、`123456789.5`、同时有 CNY 和 USD 的会话，显示时不能出现科学计数法、浮点误差或把两种币种加在一起（Task 6 测试）。
3. **两个 dsh 进程同时改预算**（web 和终端各开一个）：任何一方的修改都不能被另一方覆盖丢失；已提醒状态也不能被回退（Task 4 测试）。
4. **从未配置 DeepSeek key 或账号已退出**：费用条上的余额位置要提示“去设置里配置 DeepSeek”或“账号已退出”，不能显示 0，也不能一直转圈（Task 4、Task 7 测试）。
5. **非法或恶意的 Remote 参数**（字段缺失、类型不对、`from > to`、超长字符串、未知预算 id）：返回 `gateway/bad-request` 或 `tally/not-found`，不能抛出未处理异常，也不能写坏预算文件（Task 2 测试）。

---

### Task 1: 打通全链路的最小骨架

把 Host 服务、浏览器端接口描述、`dsh-tally-ui` 打包和挂载、真实 dsh web 上的端到端测试一次打通，只实现一个方法 `status`。后续任务都建立在这条链路上，所以这里先验证它在真实环境里可行。

**Files:**
- Create: `packages/tally/src/remote/contract.ts`、`packages/tally/src/remote/service.ts`
- Modify: `packages/tally/src/index.ts`（挂载 `TallyRemote`）、`packages/tally/package.json`（`exports['./remote']`、依赖）、`packages/tally-api/src/index.ts`（新增类型 `TallyStatusView`）
- Create: `packages/tally-ui/{package.json,tsconfig.json,tsdown.config.ts,cordis.patch.yml,LICENSE,README.md}`、`packages/tally-ui/src/index.ts`（Host 端，只有 `export const name` 和空的 `apply`）、`packages/tally-ui/src/client/{index.ts,locales.ts,StatusDot.tsx}`、`scripts/check-client-bundle.mjs`
- Test: `packages/tally/tests/remote-status.test.ts`、`packages/tally-ui/tests/e2e/web.e2e.test.ts`
- Modify: 根目录 `package.json`（devDependencies，`build` 后执行 bundle 检查）、`vitest.e2e.config.ts`（如需要）

**Interfaces:**
- Produces（`dsh-tally-api`，只有类型）：
  - `interface TallyStatusView { usage: TallyStatus; catalogVersion: string; pricingErrors: string[]; budgetErrors: string[]; balanceRoutes: string[] }`。
- Produces（`dsh-tally/remote`，`contract.ts`）：
  - `export const TALLY_REMOTE: TypertRemoteContribution`，同时作为默认导出；
  - 每个方法的 zod schema 以 `schemas.<method>.request` / `schemas.<method>.result` 导出，供 Host 端校验；
  - `declare module '@deepseek-ai/dsh-typert-protocol'` 合并 `TypertRemoteNamespaceMap['tally']` 和 `TypertRemoteMap['tally/<method>']`，签名形如 `status: () => Promise<RemoteResult<TallyStatusView>>`。
  - descriptor 的形状照抄安装包 `@deepseek-ai/dsh-experimental-api-speech-to-text/lib/typert.remote-client.js`：`package: 'dsh-tally'`，`id: 'dsh-tally#tally/<method>'`，`service: 'tallyRemote'`，`namespace: 'tally'`，`invocation: { kind: 'direct' }`，参数和结果用 `mode: 'strict'` 加 `typeSymbol: 'dsh-tally-api#<TypeName>'` 和 `create: () => schema`。
- Produces（`service.ts`）：`class TallyRemote extends TypertRemoteService`，构造为 `super(ctx, 'tallyRemote', { namespace: 'tally' })`，`static inject = ['tallyUsage', 'tallyPricing', 'tallyBalance', 'tallyBudget']`，方法 `@Remote status(): Promise<TallyStatusView>`。`balanceRoutes` 来自 `TallyBalance` 新增的只读方法 `routes(): string[]`。
- Produces（`dsh-tally-ui` 浏览器端）：插件 `inject = ['remote', 'slots', 'locale']`。`apply` 里：
  1. `const dispose = await ctx.remote.$mount(TALLY_REMOTE)`，用 `ctx.effect` 管理；
  2. 用 `ctx.locale.register('tally', { zh, en })` 注册字典；
  3. 在 `ctx.inject(['remote.tally'], …)` 里向 `conversation.session.header.utilities` 注册 `StatusDot`。它调用 `status()`，成功时渲染 `data-tally="status"` 和 `data-ready="true"`，失败时渲染 `data-ready="false"`，并带上 `t('status.unavailable')` 的 title。（Task 7 会把它换成正式的会话累计组件。）
- `dsh-tally-ui` 的 `package.json`：
  - `exports['.']` → `lib/index.js`；`exports['./client']` → `{ types: './lib/types/client/index.d.ts', default: './lib/client.js' }`；
  - `"dsh": { "client": { "platform": "web", "inject": ["remote", "slots", "locale"] }, "bundle": { "patch": "./cordis.patch.yml" } }`；
  - `cordis.patch.yml` 为 `- insert: [{ id: tally-ui, name: dsh-tally-ui }]`；
  - 不声明 `dsh.client.external`。
- `tsdown.config.ts` 按 `$DSH_SRC/packages/client/tsdown.client.ts` 的 `clientConfig()` 复刻：`format: 'cjs'`、`platform: 'browser'`、`entryFileNames: 'client.js'`、`sourcemap: true`；banner 和 footer 包出 `window.__ModuleLoader__.load({ id: 'dsh-tally-ui', factory: (require) => { var module={exports:{}}; var exports=module.exports; … return module.exports; } })`；`external` 恰好是 Global Constraints 里的共享模块表。CSS 用 `.module.css` 加构建期内联，或者在 factory 执行时注入 `<style>`，二选一，写进 README。
- `scripts/check-client-bundle.mjs <bundle>`：扫描 bundle 里所有 `require("…")`，出现共享模块表以外的模块名就以非零码退出，并打印模块名。

**执行中的判断规则（遇到时按此处理，并记入执行记录）：**
- 编译后的 `lib` 里，Host 端 `@Remote` 方法如果不被网关识别（`ctx.typertGateway.invoke` 返回“未知方法”），改为在 `TallyRemote` 构造函数里用 `bindTypertRemote` 加 `ctx.typert.register` 手动注册，descriptor 复用 `contract.ts`。
- 浏览器端如果拒绝手写的 contribution，改用官方 `@deepseek-ai/dsh-typert-generator/tsdown` 的 `typertPlugin({ mode: 'package' })` 生成。它要求根目录有 `tsconfig.host.json` 和 `tsconfig.client.json`，并依赖 `typescript ^6`，只在生成步骤里使用。此时 `contract.ts` 改为只导出 zod schema。
- 以上两条以外的偏差都先停下来报告，不要自行绕过。

- [ ] **Step 1：写失败的测试。**
  - `remote-status.test.ts`：在一个 Context 里依次加载 `@deepseek-ai/dsh-typert-registry`、`@deepseek-ai/dsh-api-gateway`（默认导出，配置 `{}`）、整个 `dsh-tally` 插件（临时 `dbPath` 和 `budgetPath`），再注册一个假余额路由 `r1`。
    - 断言 `await ctx.typertGateway.invoke({ namespace: 'tally', method: 'status', args: {} })` 成功；
    - 断言结果里 `balanceRoutes` 等于 `['r1']`，`catalogVersion` 等于 `ctx.tallyPricing.catalogVersion()`；
    - 断言 `TALLY_REMOTE.descriptors.map(d => d.method)` 等于 `['status']`；
    - 断言 `schemas.status.result.parse(result)` 不抛异常。
  - `web.e2e.test.ts`：
    1. 在临时 `DSH_HOME` 下，对 `packages/tally` 和 `packages/tally-ui` 分别执行 `dsh plugin --profile web add <dir>`；
    2. 启动 `dsh --profile web --no-open --port 0`，环境变量与 headless e2e 相同（mock 模型服务器、`DEEPSEEK_API_KEY=mock-key`）；
    3. 从输出中匹配 `/dsh web: (http:\/\/[^\s]+)/`，最多等 90 秒；
    4. 用 playwright 的 chromium 打开这个 URL，新建一个会话；
    5. 断言 `[data-tally="status"][data-ready="true"]` 在 30 秒内出现；
    6. 断言页面没有 `console.error`，并且 dsh 的 stderr 不含 `ExperimentalWarning` 和 `failed to import`。
- [ ] **Step 2：运行，预期 FAIL。** `pnpm vitest run packages/tally/tests/remote-status.test.ts`。
- [ ] **Step 3：实现 Host 服务、`contract.ts`、`dsh-tally-ui` 骨架、打包配置和 bundle 检查脚本。** 根目录 `build` 脚本在 `pnpm -r run build` 之后对 `packages/tally-ui/lib/client.js` 运行检查脚本。
- [ ] **Step 4：运行 `pnpm test`、`pnpm typecheck`、`pnpm test:e2e`，全部通过。** 如果用到了上面的判断规则，把用了哪一条、为什么写进 `packages/tally-ui/README.md` 的“构建说明”一节。
- [ ] **Step 5：提交。** `git commit -m "feat(tally,tally-ui): tally Remote namespace and client bundle walking skeleton on real dsh web"`

---

### Task 2: Remote API 的完整方法

**Files:**
- Modify: `packages/tally/src/remote/{contract.ts,service.ts}`、`packages/tally-api/src/index.ts`、`packages/tally/src/store.ts`（按会话和 seq 范围取账目）、`packages/tally/src/usage-service.ts`（`sessionView`、`turn`、`exportCsv`、`peakSavings` 的实现）
- Modify: `packages/pricing-data/src/{band.ts,quote.ts,index.ts}`
- Test: `packages/tally/tests/remote-api.test.ts`、`packages/pricing-data/tests/band.test.ts`、`packages/pricing-data/tests/quote.test.ts`

**Interfaces:**
- Produces（`dsh-pricing-data`）：
  - `nextBandChange(windows: PeakWindows | undefined, holidays: HolidayCalendars, at: number): number | null`：返回严格大于 `at`、并且 `resolveBand` 结果与 `at` 时不同的最早毫秒时间戳；没有 `windows`（即 flat）时返回 `null`。向后最多查找 8 天，候选时刻是每天各个窗口的起止时刻和当地零点。
  - `QuoteRequest` 新增可选字段 `band?: Band`：给出时强制使用该档位的单价（该档位不存在则返回 `null`），其余逻辑不变。
- Produces（`dsh-tally-api`，只有类型，均为新增）：
  - `interface SessionView { usage: SessionUsage; lastRoute: string | null; lastModel: string | null }`
  - `interface TurnUsage { total: UsageGroup; attempts: TallyEntry[] }`
  - `interface BandView { band: TallyBand; until: number | null; holidayCalendarMissing: boolean }`
  - `interface CatalogView { version: string; providers: { id: string; currency: Currency; models: { model: string; priceVersion: string; effectiveFrom: string; source: { url: string; retrievedAt: string } }[] }[] }`（每个模型只列当前生效的价格版本）
  - `interface PeakSavings { peak: Money[]; offpeakEquivalent: Money[]; saving: Money[] }`（按币种分开）
- Produces（Remote 方法，全部为 `@Remote`，参数是单个 `request`）：

| 方法 | request | 返回 |
|---|---|---|
| `query` | `UsageQuery` | `UsageGroup[]` |
| `session` | `{ sessionId: string }` | `SessionView` |
| `turn` | `{ sessionId: string; fromSeq: number; toSeq: number }`（闭区间） | `TurnUsage`（只含本会话的账目，按 `at` 升序） |
| `band` | `{ route: string; model: string; at: number }` | `BandView \| null`（无价格时为 `null`） |
| `balance` | `{ route: string }` | `BalanceSnapshot \| null` |
| `refreshBalance` | `{ route: string }` | `BalanceSnapshot \| null` |
| `budgets` | 无 | `Budget[]` |
| `setBudget` | `Budget` | `void`（非法时 `RemoteError('tally/invalid-budget', message)`） |
| `removeBudget` | `{ id: string }` | `void`（不存在时 `RemoteError('tally/not-found', …)`） |
| `catalog` | 无 | `CatalogView` |
| `peakSavings` | `{ from: number; to: number }` | `PeakSavings`（把区间内 band 为 `peak` 的账目按 `offpeak` 单价重算） |
| `exportCsv` | `{ from: number; to: number; tz: string }` | `string`（UTF-8 CSV，带表头 `time,session,root_session,workspace,route,model,band,input,cache_read,cache_write,output,cost,currency,price_version,usage_known`；时间按 `tz` 输出 ISO 8601 带偏移；`cost` 无价格时为空，不写 0） |
| `rebuild` | 无 | `void` |

- 错误代码在 `contract.ts` 里通过 `RemoteErrorDetailsMap` 声明：`tally/not-found`、`tally/invalid-budget`。参数非法统一用 `gateway/bad-request`，额外规则：`from < to`、`to - from` 不超过 400 天、字符串字段不超过 256 个字符、`fromSeq <= toSeq`。

- [ ] **Step 1：写失败的测试。**
  - `band.test.ts`：DeepSeek 窗口（周一至周五 09:00-12:00、14:00-18:00，Asia/Shanghai）下：
    - 周三 11:59:59 +08:00 的下一次切换是当天 12:00；
    - 周五 18:30 的下一次切换是下周一 09:00；
    - 没有 `windows` 时返回 `null`。
  - `quote.test.ts`：`deepseek-flash` 在高峰时刻以 `band: 'offpeak'` 报价，金额等于空闲价，并且 `band` 字段为 `'offpeak'`。
  - `remote-api.test.ts`：沿用 Task 1 的网关加整插件夹具，并用 `usage-service.test.ts` 的会话夹具写入账目。逐个方法通过 `ctx.typertGateway.invoke` 调用，断言：
    - 结果与直接调用对应服务一致；
    - `turn` 只返回 seq 在区间内的账目；
    - `exportCsv` 的行数等于账目数，未定价行的 `cost` 列为空；
    - `peakSavings` 对一条高峰账目给出“高峰价减空闲价”的 `saving`；
    - 非法参数逐条返回 `gateway/bad-request`：缺 `from`、`from > to`、401 天、300 字符的 `sessionId`、`fromSeq > toSeq`（Review Focus 5）；
    - `removeBudget({ id: 'nope' })` 返回 `tally/not-found`；
    - `setBudget` 传入 `limit.amount: '-1'` 时返回 `tally/invalid-budget`，并且预算文件内容不变。
  - 用 `remoteErrorOf(error)` 断言错误，不要用 `instanceof`。
- [ ] **Step 2：运行，预期 FAIL。**
- [ ] **Step 3：实现。** 每个方法开头先用 `schemas.<method>.request.safeParse` 校验，再调用服务。`turn` 通过 store 按 `session_id` 取账目，再按 id 中的 seq（`sessionId + ':' + seq`）过滤。
- [ ] **Step 4：运行 `pnpm test && pnpm typecheck`，全部通过。**
- [ ] **Step 5：提交。** `git commit -m "feat(tally): full tally Remote API with request validation, band countdown, CSV export and peak savings"`

---

### Task 3: 流式方法 `watch`

**Files:**
- Modify: `packages/tally/src/remote/{contract.ts,service.ts}`、`packages/tally-api/src/index.ts`
- Test: `packages/tally/tests/remote-watch.test.ts`

**Interfaces:**
- Produces（`dsh-tally-api`）：
```ts
export type TallyWatchFrame =
  | { type: 'hello'; status: TallyStatusView }
  | { type: 'recorded'; entry: TallyEntry }
  | { type: 'balance-changed'; snapshot: BalanceSnapshot }
  | { type: 'budget-crossed'; alert: BudgetAlert }
  | { type: 'status'; status: TallyStatusView }
```
- Produces（Remote）：`@Remote({ mode: 'stream' }) watch(signal: AbortSignal): AsyncIterable<TallyWatchFrame>`。
  - 打开时第一帧一定是 `hello`。
  - 之后按事件发生顺序转发 `tally/recorded`、`tally/balance-changed`、`tally/budget-crossed`。
  - 回填或重建进行中时，最多每 1000 ms 推一帧 `status`；结束时再推一帧。
  - 内部队列上限 1000 帧，超出时丢弃最旧的帧，并在下一次出队前插入一帧新的 `hello`，让客户端整体刷新。
  - `signal` 中止时移除所有监听器，迭代器结束。
- 浏览器端 contribution 中，`watch` 的 descriptor 是 `mode: 'stream'`，结果 codec 是 `TallyWatchFrame` 的 zod schema。

- [ ] **Step 1：写失败的测试。**
  - 直接调用 `service.watch(ac.signal)[Symbol.asyncIterator]()`：
    - 第一帧为 `hello`；
    - 依次 `ctx.emit` 三种事件，得到三帧，顺序一致；
    - `ac.abort()` 之后迭代器结束，`ctx` 上不再残留这三个事件的监听器（比较监听器数量）。
  - 队列溢出：不读取的情况下连续发出 1001 个 `tally/recorded`，再读取时先得到一帧 `hello`。
  - 通过 `ctx.typertGateway.stream({ namespace: 'tally', method: 'watch', args: {} })` 能收到 `hello`。
  - 用 fake timers 跑一次 `rebuild()`：`status` 帧之间的间隔不小于 1000 ms，最后一帧 `status` 的 `usage.backfill` 为 `null`。
- [ ] **Step 2：运行，预期 FAIL。**
- [ ] **Step 3：实现。**
- [ ] **Step 4：运行 `pnpm test && pnpm typecheck`，全部通过。**
- [ ] **Step 5：提交。** `git commit -m "feat(tally): watch stream for recorded, balance and budget events"`

---

### Task 4: 预算文件跨进程加锁、余额重试与错误代码

**Files:**
- Modify: `packages/tally/src/budget-file.ts`、`packages/tally/src/budget-service.ts`、`packages/tally/src/balance-service.ts`、`packages/tally-api/src/index.ts`、`packages/balance-deepseek/src/fetchers.ts`、`packages/tally/package.json`、两个包的 README
- Test: `packages/tally/tests/budget-file.test.ts`、`packages/tally/tests/balance-service.test.ts`、`packages/balance-deepseek/tests/fetchers.test.ts`

**Interfaces:**
- **预算文件：**
  - 所有写操作（`put`、`delete`、`markFired`）都放进 `withFileLock(path, …)`（来自 `@deepseek-ai/dsh-atomic-write`，`waitMs` 用默认值）。在锁内先重新读盘、合并本次修改，再用 `writeFileAtomic(path, text, { mode: 0o600, dirMode: 0o700 })` 写入。
  - `markFired` 合并时，同一预算取 `periodStart` 较新的记录；周期相同时，阈值取并集。已提醒状态不会被回退。
  - 读操作（`budgets()`、`fired()`、`lastFiredPeriod()`）前比较文件的 `mtimeMs` 和 `size`，有变化就重新加载。
  - 文件损坏时的隔离逻辑不变。
- **余额：**
  - `BalanceSnapshot` 新增可选字段 `errorCode?: BalanceErrorCode`，其中 `type BalanceErrorCode = 'not-configured' | 'signed-out' | 'timeout' | 'failed'`（只做加法）。
  - fetcher 抛出的异常如果带有字符串属性 `code`，并且取值在这个集合里，就照搬到快照；超时为 `'timeout'`；其他情况为 `'failed'`。
  - `dsh-tally-balance-deepseek`：未配置 key 时抛出的异常带 `code: 'not-configured'`，账号退出时带 `code: 'signed-out'`，错误信息文本不变。
  - `get(route)`：缓存的快照如果**从未成功过**（`wallets` 为空且带 `error`），并且距离它的 `fetchedAt` 已超过 `minIntervalMs`，就当作没有缓存，重新查询。

- [ ] **Step 1：写失败的测试。**
  - `budget-file.test.ts`：对同一路径开两个 `BudgetFile` 实例 A、B（模拟两个进程，Review Focus 3）：
    - A 执行 `put(x)`，B 再执行 `markFired('y', …)`，重新加载后 `budgets` 同时包含 x 和 y；
    - A 记录 P2 周期的提醒，B 再记录 P1 周期的提醒，结果仍是 P2；
    - 两个实例并发各 `put` 20 个不同预算，最终 40 个都在；
    - A 写入后，B 不调用 `load` 也能在 `budgets()` 中看到新预算。
  - `balance-service.test.ts`：
    - fetcher 抛出 `Object.assign(new Error('x not configured'), { code: 'not-configured' })` 时，快照的 `errorCode` 为 `'not-configured'`；
    - 超时时为 `'timeout'`；
    - 首次失败后立即再 `get`，返回缓存且不重新请求；把时间推进 `minIntervalMs + 1` 后再 `get`，会重新请求，并且成功后快照的 `stale` 为 `false`。
  - `fetchers.test.ts`：两种错误分别带正确的 `code`，`message` 与原来相同。
- [ ] **Step 2：运行，预期 FAIL。**
- [ ] **Step 3：实现。** 删掉 README 中“预算文件只应由一个进程写入”的说明，改为说明加锁行为。
- [ ] **Step 4：运行 `pnpm test && pnpm typecheck && pnpm test:e2e`，全部通过。**
- [ ] **Step 5：提交。** `git commit -m "feat(tally): cross-process budget file locking, balance error codes and retry after first failure"`

---

### Task 5: 已删除会话的标记，以及可在设置页编辑的配置

**Files:**
- Modify: `packages/tally/src/usage-service.ts`、`packages/tally/src/store.ts`、`packages/tally/src/pricing-service.ts`、`packages/tally/src/index.ts`、`packages/tally-api/src/index.ts`
- Modify: `packages/tally-ui/src/index.ts`（Host 端 `Config`）
- Test: `packages/tally/tests/usage-service.test.ts`、`packages/tally/tests/pricing-service.test.ts`、`packages/tally-ui/tests/config.test.ts`

**Interfaces:**
- **已删除会话：**
  - 每次回填扫描（包括启动时的增量扫描）在 `listSessions()` 成功返回后进行一次对账：账本里有账目、但不在列表中的会话，调用 `store.markSessionDeleted(id)`。
  - 只有当列表里至少有一条 `persisted: true` 的记录时才对账，避免持久化服务不可用时把所有会话都误标为删除。
  - 已标记的会话如果重新出现在列表里，清除标记（store 新增 `markSessionRestored(id)`）。
  - `UsageGroup` 新增可选字段 `deletedCount?: number`，只在 `groupBy: 'session'` 时填写，表示该组中已删除会话的账目数。删除不影响任何金额合计。
- **价格覆盖改为 volatile：**
  - `dsh-tally` 的 `Config.overrides` 声明为 `.volatile()`，`apply` 中以 `Volatile<ProviderPriceOverride[]>` 读取。
  - `TallyPricingService` 在 `loader/volatile-update` 事件涉及 `overrides` 路径时，重新构建内部的 `TallyPricing`（无效的覆盖照旧跳过，并记入 `status().errors`）。
  - 已缓存的价格分桶随之失效。不需要重建账本，因为金额本来就是查询时现算的。
  - Remote 的 `catalog` 和 `status` 反映新的覆盖配置。
- **界面开关：** `dsh-tally-ui` 的 Host 端 `Config` 为
  - `elements: { composerDock: boolean; turnTail: boolean; headerUtilities: boolean; sidebarTab: boolean; budgetToast: boolean }`，每一项都默认 `true`，都是 `.volatile()`；
  - 设置页本身不能关闭。

- [ ] **Step 1：写失败的测试。**
  - `usage-service.test.ts`：
    - 用假的 `sessionQuery` 返回会话 A、B（`persisted: true`），记账后让它只返回 A，再触发一次回填。断言 B 的账目被标记为已删除，`query({ groupBy: 'session' })` 中 B 组的 `deletedCount` 等于其账目数，所有组的 `cost` 合计不变。
    - 让列表重新包含 B，再触发一次回填，B 的标记被清除。
    - 列表为空，或者所有记录都是 `persisted: false` 时，不标记任何会话。
  - `pricing-service.test.ts`：插件以 `overrides: []` 启动，通过 `ctx.settings` 或直接改写 volatile 引用（以安装包 `.d.ts` 暴露的方式为准）加入一条 `alias` 覆盖，触发 `loader/volatile-update`。之后对该路由的报价与目标厂商一致，并且插件没有重新挂载（服务实例不变）。
  - `config.test.ts`：`dsh-tally-ui` 的 `Config({})` 中 `elements` 五项都为 `true`，并且都被识别为 volatile 字段（用 schemastery 的 `isVolatile` 断言）。
- [ ] **Step 2：运行，预期 FAIL。**
- [ ] **Step 3：实现。**
- [ ] **Step 4：运行 `pnpm test && pnpm typecheck && pnpm test:e2e`，全部通过。**
- [ ] **Step 5：提交。** `git commit -m "feat(tally): mark deleted sessions, volatile price overrides and UI element switches"`

---

### Task 6: 浏览器端数据层

不含 React 组件：把 Remote 调用和 `watch` 流整理成可订阅的状态，提供金额和数字的格式化函数，并写好完整的中英文字典。

**Files:**
- Create: `packages/tally-ui/src/client/store.ts`、`packages/tally-ui/src/client/format.ts`
- Modify: `packages/tally-ui/src/client/locales.ts`（本计划所有界面文案都在这里一次写全）
- Test: `packages/tally-ui/tests/store.test.ts`、`packages/tally-ui/tests/format.test.ts`、`packages/tally-ui/tests/locales.test.ts`

**Interfaces:**
- Produces（`format.ts`，纯函数）：
  - `formatMoney(m: Money, locale: 'zh' | 'en'): string`：千分位分组；最多保留 4 位小数，去掉尾随零；小于 `0.0001` 的正数显示为 `<0.0001`；CNY 用 `¥`，USD 用 `$`。只用字符串运算。
  - `formatMoneyList(list: Money[], locale): string`：多个币种用 ` + ` 连接，按 CNY、USD 的顺序，空列表显示为 `—`。
  - `formatTokens(n: number, locale): string`：用 `k`、`M` 缩写，保留 1 位小数。
  - `hitRate(t: TallyTokens): number | null`：`cacheRead / (input + cacheRead)`，分母为 0 时返回 `null`。
  - `formatCountdown(ms: number, locale): string`：`h:mm:ss`。
- Produces（`store.ts`）：
  - `createTallyStore(remote: TallyRemoteFace, opts: { timeZone: string; now?: () => number }): TallyStore`。
  - `TallyRemoteFace` 是 `ctx.remote.tally` 中本包用到的方法子集，便于用 `TestRemote` 替换。
  - `TallyStore` 提供：
    - `start(signal: AbortSignal): void`：打开 `watch`；
    - 可订阅快照 `status`、`balances`（按路由）、`today`（今天 0 点到明天 0 点，按 `timeZone` 计算的 `UsageGroup`）；
    - `session(sessionId)`：返回一个可订阅的 `SessionView`；
    - `alerts`：尚未展示的 `BudgetAlert` 队列，配合 `dismissAlert(alert)`。
  - 快照形如 `{ getSnapshot(): T; subscribe(listener): () => void }`，可直接用作 slot 的 `hooks`。
  - 收到 `hello` 时，所有已加载的数据整体重新拉取，`alerts` 不清空（Review Focus 1）。
  - 收到 `recorded` 时，不在本地累加金额，而是对受影响的 `today` 和对应会话做去抖（500 ms）重新拉取。这样重连前后不会重复累加。
  - 收到 `balance-changed` 时，直接替换该路由的余额。
  - 收到 `budget-crossed` 时，追加到 `alerts`。
- Produces（`locales.ts`）：`zh` 和 `en` 两个扁平字典，键包括：
  - 状态和时段：`status.unavailable`、`band.peak`、`band.offpeak`、`band.flat`、`band.countdown`；
  - 金额和余额：`money.unpriced`、`balance.stale`、`balance.notConfigured`、`balance.signedOut`、`balance.failed`；
  - 费用条：`dock.session`、`dock.today`、`dock.balance`；
  - 每轮费用：`turn.cost`、`turn.input`、`turn.cacheRead`、`turn.output`、`turn.hitRate`、`turn.requests`、`turn.priceVersion`、`turn.source`；
  - 会话累计：`header.total`、`header.subagents`；
  - 看板：`tab.title`、`tab.range.today`、`tab.range.7d`、`tab.range.30d`、`tab.range.month`、`tab.byModel`、`tab.byWorkspace`、`tab.bySession`、`tab.hitRateTrend`、`tab.savings`、`tab.export`、`tab.unpriced`、`tab.unknownWorkspace`、`tab.deleted`；
  - 设置页：`settings.nav`、`settings.catalog`、`settings.overrides`、`settings.budgets`、`settings.elements`、`settings.rebuild`、`settings.rebuildProgress`；
  - 预算提醒：`alert.reached80`、`alert.reached100`；
  - 估算说明：`disclaimer`（“估算值，以账单为准”）。
  - 占位符用 `{name}` 形式。

- [ ] **Step 1：写失败的测试。**
  - `format.test.ts`（Review Focus 2）：
    - `formatMoney({ amount: '123456789.5', currency: 'CNY' }, 'zh')` 为 `'¥123,456,789.5'`；
    - `'0.000001'` 为 `'<¥0.0001'`；
    - `'0.12345'` 为 `'¥0.1235'`（四舍五入，只用字符串运算）；
    - `'2'` 为 `'¥2'`；
    - `formatMoneyList([USD 1, CNY 2])` 为 `'¥2 + $1'`；
    - `formatTokens(1234567)` 为 `'1.2M'`；
    - `hitRate` 分母为 0 时返回 `null`。
  - `store.test.ts`：用 `TestRemote`（`@deepseek-ai/dsh-client-test-runtime`）脚本化 `ctx.remote.tally`，`watch` 用一个可手动推送帧的异步队列模拟：
    - `hello` 之后 `today` 被拉取一次；
    - 600 ms 内连续 5 个 `recorded` 只触发一次重新拉取；
    - 模拟断线后重新打开，推送新的 `hello`，所有数据重新拉取一次，`today` 等于服务端的新值而不是两次之和；
    - `balance-changed` 替换余额；
    - `budget-crossed` 进入 `alerts`，`dismissAlert` 后移除。
  - `locales.test.ts`：`zh` 与 `en` 的键集合相等，并且没有空字符串。
- [ ] **Step 2：运行，预期 FAIL。**
- [ ] **Step 3：实现。**
- [ ] **Step 4：运行 `pnpm test && pnpm typecheck`，全部通过。**
- [ ] **Step 5：提交。** `git commit -m "feat(tally-ui): client data store, money formatting and zh/en dictionaries"`

---

### Task 7: 对话区的三个元素和预算提醒

**Files:**
- Create: `packages/tally-ui/src/client/{CostDock.tsx,TurnCost.tsx,SessionTotal.tsx,BudgetToast.tsx,BalanceText.tsx}` 及对应的 `.module.css`
- Modify: `packages/tally-ui/src/client/index.ts`（注册元素，删除 Task 1 的 `StatusDot`）
- Test: `packages/tally-ui/tests/conversation.client.test.tsx`、`packages/tally-ui/tests/plugin.client.test.ts`

**Interfaces:**
- Consumes：Task 6 的 `TallyStore`、`format.ts`、字典；Task 5 的 `elements` 开关，通过 `ctx.configForms.get('tally-ui')` 读取，作为 `hooks` 传给组件，开关为 `false` 时组件返回 `null`；Task 2 的 `band`、`turn` 方法。
- 注册位置（都用 `ctx.slots.inject(name, () => ctx.slots.register({ … locale: 'tally' }, Component))`）：

| slot | 组件 | 内容 |
|---|---|---|
| `conversation.composer.dock`（`id: 'tally.dock'`） | `CostDock` | 本会话费用 · 今日费用 · 余额（`BalanceText`）· 当前时段和倒计时（每秒更新一次，归零时重新调用 `band`）。没有任何账目时只显示今日费用和余额。 |
| `conversation.chat.turnTail`（`id: 'tally.turn'`） | `TurnCost` | 这一轮的费用（用 `turn.start.seq` 到 `turn.end.seq` 调用 `turn`）。悬停（`Tooltip` 或 `HoverCard`）显示：输入、缓存命中、输出、命中率、请求次数（含重试）、价格版本（链接到 `catalog` 里的来源 URL）。这一轮没有账目时返回 `null`。 |
| `conversation.session.header.utilities`（`id: 'tally.total'`） | `SessionTotal` | 会话累计（含子代理）。点击展开 `MenuSurface`，列出各子代理会话的费用。 |
| `shell.overlay`（`id: 'tally.budget'`） | `BudgetToast` | 取 `alerts` 队首，用 `Toast` 显示 `alert.reached80` 或 `alert.reached100`（带预算金额和已用金额），关闭时调用 `dismissAlert`。 |

- 与设计文档的差异：§5.6 写的是“重试次数”，但账目只记录到“计费尝试”这一级，不记录它属于哪一步，无法可靠区分“重试”和“同一轮里的多次请求”。因此这里显示“请求次数（含重试）”，即这一轮的账目条数。
- `BalanceText` 的显示规则（Review Focus 4）：
  - 显示的路由取本会话 `lastRoute`；没有时取 `status.balanceRoutes` 中的第一个；都没有时不显示余额。
  - 正常时显示 `total` 钱包（多个币种用 `formatMoneyList`）；`stale` 时在后面加 `balance.stale` 标记。
  - 从未成功过时：`errorCode` 为 `not-configured` 显示 `balance.notConfigured`，为 `signed-out` 显示 `balance.signedOut`，其余显示 `balance.failed`。**任何情况都不显示 0。**
  - 点击余额时调用 `refreshBalance`，请求进行中显示加载状态，最长 10 秒。
- 所有可交互元素都有 `data-tally="<名称>"` 属性，供 e2e 定位。

- [ ] **Step 1：写失败的测试。** 每个组件测试文件第一行写 `// @vitest-environment jsdom`，用 `@testing-library/react` 直接传 props 渲染，`t` 用 `key => zh[key]`。
  - `CostDock`：
    - 金额为 `null` 的项显示“未定价”；
    - 余额从未成功、`errorCode: 'not-configured'` 时显示 `balance.notConfigured` 的文案，页面上不出现 `¥0`；
    - 余额 `stale` 时显示过期标记；
    - 倒计时用 fake timers 推进 1 秒后减少 1 秒；
    - `elements.composerDock` 为 `false` 时什么都不渲染。
  - `TurnCost`：
    - 悬停后出现命中率、请求次数和价格版本链接；
    - 没有账目时什么都不渲染。
  - `SessionTotal`：展开后列出子代理行。
  - `BudgetToast`：80% 提醒的文案包含两个金额；关闭后调用 `dismissAlert`。
  - `plugin.client.test.ts`：用 `SlotTestRuntime.create()` 加 `TestRemote` 加载浏览器插件，断言四个 slot 各注册了一个元素，`id` 与上表一致。
- [ ] **Step 2：运行，预期 FAIL。**
- [ ] **Step 3：实现。** 样式只用 `--dsw-alias-*` 变量；数字使用 `font-variant-numeric: tabular-nums`。
- [ ] **Step 4：运行 `pnpm test && pnpm typecheck && pnpm build`，全部通过，bundle 检查通过。**
- [ ] **Step 5：提交。** `git commit -m "feat(tally-ui): composer cost dock, per-turn cost, session total and budget toast"`

---

### Task 8: 右侧栏用量看板

**Files:**
- Create: `packages/tally-ui/src/client/dashboard/{definition.ts,Dashboard.tsx,DailyChart.tsx,Rankings.tsx,HitRateTrend.tsx,Savings.tsx,ExportButton.tsx}` 及样式
- Modify: `packages/tally-ui/src/client/index.ts`
- Test: `packages/tally-ui/tests/dashboard.client.test.tsx`、`packages/tally-ui/tests/chart.test.ts`

**Interfaces:**
- 注册：
  - `ctx.sidebarRightTabs.register({ id: 'tally.dashboard', kind: 'tally.dashboard', title: () => t('tab.title'), guide: [{ id: 'tally.dashboard', order: 50, title: () => t('tab.title') }] })`；
  - `ctx.slots.register({ name: 'sidebar.right.pane.tab', key: 'tally.dashboard', locale: 'tally' }, Dashboard)`；
  - `elements.sidebarTab` 为 `false` 时两项都不注册（在 `configForms` 的订阅里注册和注销）。
- `Dashboard` 的内容：
  - 时间范围用 `SegmentedControl` 选择：今天、7 天、30 天、本月；按浏览器时区计算 `from` 和 `to`。
  - 按天的柱状图（`DailyChart`）：每天发两次 `query`（`filter.band` 分别为 `peak` 和 `offpeak`，`groupBy: 'day'`），高峰和空闲分色叠加；flat 档位并入空闲色；每个币种一张图。
  - 排行（`Rankings`）：按模型、工作区、会话各取前 10，`workspaceId` 缺失时显示 `tab.unknownWorkspace`，已删除会话加 `tab.deleted` 标记。
  - 缓存命中率趋势（`HitRateTrend`）：按天的折线。
  - 峰谷节省提示（`Savings`）：调用 `peakSavings`，以事实形式写成“本期高峰时段费用 X，同样用量在空闲时段为 Y”。
  - 导出 CSV（`ExportButton`）：调用 `exportCsv`，用 `Blob` 和临时 `<a download>` 下载，文件名为 `tally-<from>-<to>.csv`。
  - 未定价请求数：合计 `unpricedCount`；大于 0 时显示入口，点击后打开设置页的价格覆盖部分。
- `chart.ts`（纯函数，Task 8 新增）：`stackedBars(days: { key: string; peak: string; offpeak: string }[], width: number, height: number): { x: number; y: number; w: number; h: number; band: 'peak' | 'offpeak'; key: string }[]`。金额先换算成相对最大值的比例再计算像素，这一步允许使用浮点数，因为结果是像素坐标，不是金额。

- [ ] **Step 1：写失败的测试。**
  - `chart.test.ts`：
    - 两天数据中，最大的一天柱高等于 `height`；
    - 高峰段在空闲段之上；
    - 全为 0 时所有矩形高度为 0，不出现 `NaN`。
  - `dashboard.client.test.tsx`（jsdom 加 `TestRemote`）：
    - 切换到“7 天”时，`query` 的 `to - from` 等于 7 天；
    - 存在未定价请求时出现入口；
    - 点击导出后调用了 `exportCsv`，并创建了下载链接；
    - 节省提示中的两个金额来自 `peakSavings` 的返回值。
- [ ] **Step 2：运行，预期 FAIL。**
- [ ] **Step 3：实现。**
- [ ] **Step 4：运行 `pnpm test && pnpm typecheck && pnpm build`，全部通过。**
- [ ] **Step 5：提交。** `git commit -m "feat(tally-ui): usage dashboard sidebar tab with charts, rankings, savings and CSV export"`

---

### Task 9: 设置页

**Files:**
- Create: `packages/tally-ui/src/client/settings/{Section.tsx,CatalogInfo.tsx,OverridesEditor.tsx,BudgetsEditor.tsx,ElementSwitches.tsx,RebuildButton.tsx}` 及样式
- Modify: `packages/tally-ui/src/client/index.ts`
- Test: `packages/tally-ui/tests/settings.client.test.tsx`

**Interfaces:**
- 注册：`ctx.slots.register({ name: 'settings.section', id: 'tally', order: 50, label: () => t('settings.nav'), locale: 'tally', inject }, Section)`，插件 `inject` 加上 `configForms`。
- 各部分：
  - `CatalogInfo`：`catalog()` 的价格数据版本，以及每个厂商、模型当前的价格版本、生效日期和来源链接；附 `disclaimer`。
  - `OverridesEditor`：读写 `ctx.configForms.get('tally')` 的 `overrides` 字段。
    - 支持添加 `alias`（路由 id 和目标厂商、模型）和 `manual`（路由 id、币种、按模型填写单价）两种覆盖，以及删除；
    - 单价输入框只接受 `^\d+(\.\d{1,12})?$`，否则不允许保存；
    - 表单状态为 `unavailable` 或 `writable: false`、或者 `mode: 'memory'` 时，只读显示，并说明原因。
  - `BudgetsEditor`：通过 Remote 的 `budgets`、`setBudget`、`removeBudget` 管理预算，字段为周期、工作区（可选）、金额和币种；保存失败时显示服务端返回的错误信息。
  - `ElementSwitches`：读写 `ctx.configForms.get('tally-ui')` 的 `elements.*`，每个开关一个 `Switch`。
  - `RebuildButton`：点击后先确认，再调用 `rebuild`；进行中根据 `watch` 的 `status` 帧显示 `settings.rebuildProgress`（`done/total`），并禁用按钮。

- [ ] **Step 1：写失败的测试。**（jsdom，用 `TestRemote` 和一个最小的 `configForms` 假对象，后者需实现 `getSnapshot`、`subscribe`、`set`。）
  - 在单价输入框填入 `1.5e-3` 时保存按钮不可用，填入 `0.0015` 时可用；保存后 `set('overrides', …)` 收到的值正确。
  - 表单为 `mode: 'memory'` 时编辑控件被禁用，并显示原因。
  - 新建一个按月 100 CNY 的预算后调用了 `setBudget`；服务端返回 `tally/invalid-budget` 时显示错误信息。
  - 关闭 `turnTail` 开关后调用了 `set('elements.turnTail', false)`。
  - 重建进行中按钮禁用；收到 `backfill: null` 的 `status` 帧后恢复。
- [ ] **Step 2：运行，预期 FAIL。**
- [ ] **Step 3：实现。**
- [ ] **Step 4：运行 `pnpm test && pnpm typecheck && pnpm build`，全部通过。**
- [ ] **Step 5：提交。** `git commit -m "feat(tally-ui): settings section for catalog, overrides, budgets, element switches and rebuild"`

---

### Task 10: 真实 dsh web 的完整验收、自检和文档

**Files:**
- Modify: `packages/tally-ui/tests/e2e/web.e2e.test.ts`、`tests/trust.test.ts`、`packages/tally-ui/README.md`、`packages/tally/README.md`、`packages/tally-api/README.md`
- Create: `packages/tally-ui/tests/e2e/screenshots/`（运行时生成，加入 `.gitignore`）

**Interfaces:**
- Consumes：前面所有任务的 `data-tally` 定位属性；headless e2e 里的 mock 模型服务器。

- [ ] **Step 1：扩展 e2e。** 沿用 Task 1 的启动方式，另外用 `dsh plugin --profile web add` 安装 `packages/balance-deepseek`，并像计划 2 的 e2e 一样，通过 `--patch` overlay 把 `tally-balance-deepseek` 条目的 `baseURL` 指向本地 stub 余额服务。然后在真实 dsh web 中依次断言：
  1. 新建会话并发送一条消息（mock 模型回复），等这一轮结束后：
     - `[data-tally="dock"]` 中本会话费用不再是“未定价”，也不是 `¥0`；
     - `[data-tally="turn"]` 出现，悬停后能看到命中率；
     - `[data-tally="total"]` 出现。
  2. 余额：stub 余额服务（与计划 2 的 e2e 相同）返回 110 CNY，费用条显示 `¥110`；把 stub 改为返回 401，点击余额刷新后，显示 `¥110` 和过期标记。
  3. 打开右侧栏的用量看板，柱状图至少有一个高峰或空闲矩形；点击导出，触发一次下载。
  4. 打开设置页的 tally 部分：
     - 新建一个按日、金额 0.000001 CNY 的预算，再发一条消息，`shell.overlay` 中出现预算提醒；
     - 关闭 `turnTail` 开关后，新一轮不再显示 `[data-tally="turn"]`。
  5. 重新加载页面（模拟断线重连），费用条的数值与重新加载前相同（Review Focus 1）。
  6. 每一步截图保存到 `screenshots/`；整个过程页面没有 `console.error`，dsh 的 stderr 没有 `ExperimentalWarning` 和 `failed to import`。
- [ ] **Step 2：扩展自检。** `tests/trust.test.ts` 加入 `packages/tally-ui`，断言 `redLines` 为空，并且没有 `credentials` 和 `network` 能力。
- [ ] **Step 3：写文档。**
  - `packages/tally-ui/README.md`（中文）：功能和各元素截图位置说明、安装命令 `dsh plugin --profile web add dsh-tally dsh-tally-ui`、元素开关、构建说明（包括 Task 1 的判断规则是否用到）、bundle 共享模块限制。
  - `packages/tally/README.md`：新增“Remote API”一节，包括方法表、`watch` 帧格式、错误代码，以及第三方界面如何 `import TALLY_REMOTE from 'dsh-tally/remote'` 并 `$mount`。
  - `packages/tally-api/README.md`：新增类型列表。
- [ ] **Step 4：运行 `pnpm test`、`pnpm typecheck`、`pnpm test:e2e`、`pnpm test:perf`，全部通过。**
- [ ] **Step 5：提交。** `git commit -m "test(tally-ui): end-to-end UI acceptance on real dsh web, trust gate and docs"`

---

## 计划 3 完成标准

- `pnpm test`、`pnpm typecheck`、`pnpm test:e2e`、`pnpm test:perf` 全部通过。
- 在真实的 dsh 0.2.0-rc.2 web 中，费用条、每轮费用、会话累计、用量看板、设置页、预算提醒六个位置都通过 e2e 验证，并留有截图。
- dsh-trust-check：`dsh-pricing-data`、`dsh-tally-api`、`dsh-tally`、`dsh-tally-ui` 没有红线；`dsh-tally-balance-deepseek` 只有 `creds-network`。
- 浏览器 bundle 检查通过，只引用宿主共享模块。
- 设计文档 §5.3 中 Remote API 的要求、§5.6 的全部界面要求，以及计划 1、2 留下的四项后端事项（会话删除标记、覆盖可编辑、预算文件加锁、余额重试和错误代码）都有实现，并有测试覆盖。

## 留给后续计划的事项

- **计划 4**：对账工具、中国法定节假日数据、其他厂商价格、DeepSeek 历史价格补录、兼容矩阵 CI（`latest` 和 `alpha` 两个通道）、npm 发布、awesome 列表收录和接入 PR。
- 如果 Task 1 用到了官方生成器（判断规则第二条），计划 4 发布前需要复核生成器版本与 dsh 版本的对应关系。
