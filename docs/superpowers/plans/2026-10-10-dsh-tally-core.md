# dsh-tally 核心（计划 1/4）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付三个包：`dsh-pricing-data`、`dsh-tally-api` 和 `dsh-tally`（账本核心）。装上 `dsh-tally` 后，其他插件就能通过 `inject: ['tallyUsage']` 查询按会话、按天、按模型统计的 token 用量和人民币费用，数据来自 dsh 的会话日志。

**Architecture:** pnpm monorepo 中的三个 ESM TypeScript 包。`dsh-pricing-data` 是纯数据加纯函数，不依赖 dsh。`dsh-tally-api` 只包含类型。`dsh-tally` 是一个 Cordis bundle，注册 `ctx.tallyPricing` 和 `ctx.tallyUsage` 两个服务。它监听 `session/event` 实时记账，首次启动时通过 `ctx.sessionQuery` 回放历史会话，账目写入 `$DSH_HOME/tally/tally.v1.sqlite`（使用 `node:sqlite`），金额在查询时现算。

**Tech Stack:** Node ≥22.19（使用内置 `node:sqlite`）、TypeScript 5（strict，`module: nodenext`）、pnpm workspace、vitest 3、`@deepseek-ai/cordis`、`@deepseek-ai/schemastery`，以及官方 dsh 包 `0.2.0-rc.2`（作为 peer 和 dev 依赖）。

**Spec:** `docs/superpowers/specs/2026-10-10-dsh-tally-design.md`

**本计划不包含**：余额服务和预算（计划 2）、Remote API 和界面（计划 3）、对账工具、发布和推广（计划 4）。设计文档第 5.3 节接口里的 `tallyBalance` 和 `tallyBudget` 在本计划中只声明类型，不提供实现。

## Global Constraints

- 包名固定为 `dsh-pricing-data`、`dsh-tally-api`、`dsh-tally`；服务名固定为 `tallyPricing`、`tallyUsage`（`tallyBalance` 和 `tallyBudget` 只声明类型）；事件名固定为 `tally/recorded`。
- 所有包都是 `"type": "module"`，`engines.node` 为 `">=22.19.0"`，许可证 MIT。
- 和宿主共享实例的包同时声明在 `peerDependencies` 和 `devDependencies` 中。peer 版本范围：`@deepseek-ai/cordis` 为 `">=4.0.4-0 <4.1.0-0"`，`@deepseek-ai/schemastery` 为 `">=3.18.4-0 <3.19.0-0"`，`@deepseek-ai/dsh-*` 为 `">=0.2.0-0 <0.3.0-0"`；devDependencies 固定到 `0.2.0-rc.2`、`4.0.4`、`3.18.4`。
- 金额一律用十进制字符串表示，计算用 BigInt 定点运算，**禁止使用浮点数**。
- 查不到价格时返回 `null`，**永远不返回 `"0"`**。
- 账本不进入模型请求路径：不监听任何 waterfall 事件，不调用 `agent.inject()`。
- 数据库路径为 `dshHomePath('tally', 'tally.v1.sqlite')`，schema 版本 `PRAGMA user_version = 1`。
- DeepSeek 路由 id `deepseek-official` 和 `deepseek-account` 默认映射到价格数据中的厂商 `deepseek`。
- 代码标识符和注释用英文，面向用户的文档用中文。

## Review Focus

1. **进程被杀导致的残缺日志**：一轮对话没有 `step/end` 和 `turn/end`。账本只记录已经结算的尝试，不能崩溃，也不能把未结算的流式样本记成账目（Task 5 测试 `truncated turn`）。
2. **宿主时区不是北京时间**：例如进程运行在 `TZ=America/Los_Angeles`。峰谷时段必须按 `Asia/Shanghai` 判断；按天分组时使用查询传入的 `tz`（Task 2、Task 7 测试）。
3. **自定义厂商和别名模型**：没有价格时，这类请求必须计入 `unpricedCount`，不能被算成 0 元（Task 7 测试）。
4. **单个会话损坏或需要迁移**：`readSession` 抛异常时，回填要跳过这个会话、记录到 `status().errors`，其余会话照常处理（Task 8 测试）。
5. **账本规模大**：10 万条账目的 `query` 要在 1 秒内返回（Task 7 性能测试）。

---

### Task 1: monorepo 骨架和十进制运算

**Files:**
- Create: `package.json`（根，private）、`pnpm-workspace.yaml`、`tsconfig.base.json`、`vitest.config.ts`、`.gitignore`
- Create: `packages/pricing-data/package.json`、`packages/pricing-data/tsconfig.json`
- Create: `packages/pricing-data/src/decimal.ts`
- Test: `packages/pricing-data/tests/decimal.test.ts`

**Interfaces:**
- Produces:
  - `parseDecimal(s: string): Fixed`，其中 `Fixed = { units: bigint }`，固定 18 位小数（`units = value × 10^18`）。非法字符串、负数、超过 12 位小数时抛出 `RangeError`。
  - `costOf(tokens: number, ratePerMillion: Fixed): Fixed`，计算 `tokens × rate / 1_000_000`，结果精确（18 位小数足够：费率最多 12 位小数，除以 10^6 后最多 18 位）。
  - `addFixed(a: Fixed, b: Fixed): Fixed`
  - `formatFixed(f: Fixed): string`：不带多余尾随零，零写作 `"0"`，不用科学计数法。

- [ ] **Step 1：写骨架。**
  - 根 `package.json`：`"private": true`，`"packageManager": "pnpm@10"`；scripts 包括 `"build": "pnpm -r run build"`、`"test": "vitest run"`、`"typecheck": "pnpm -r run typecheck"`；devDependencies 为 `typescript@~5.8`、`vitest@^3`、`@types/node@^22`。
  - `pnpm-workspace.yaml`：`packages: ['packages/*']`。
  - `tsconfig.base.json`：`strict`、`module`/`moduleResolution` 设为 `nodenext`、`target: es2023`、`declaration`、`outDir: lib`、`rootDir: src`。
  - `packages/pricing-data/package.json`：`name: dsh-pricing-data`，`exports: { ".": { "types": "./lib/index.d.ts", "default": "./lib/index.js" }, "./catalog.json": "./catalog.json" }`，`files: ["lib", "catalog.json"]`；scripts 为 `build: tsc -p .` 和 `typecheck: tsc -p . --noEmit`。
  - `.gitignore`：`node_modules`、`lib`、`*.sqlite`。

- [ ] **Step 2：写失败的测试** `tests/decimal.test.ts`：
```ts
expect(formatFixed(costOf(1_000_000, parseDecimal('2')))).toBe('2')
expect(formatFixed(costOf(1234, parseDecimal('2')))).toBe('0.002468')
expect(formatFixed(costOf(5678, parseDecimal('0.04')))).toBe('0.00022712')
expect(formatFixed(addFixed(addFixed(costOf(1234, parseDecimal('2')), costOf(5678, parseDecimal('0.04'))), costOf(910, parseDecimal('8'))))).toBe('0.00997512')
expect(formatFixed(costOf(0, parseDecimal('27.0')))).toBe('0')
expect(formatFixed(costOf(1, parseDecimal('0.000000000001')))).toBe('0.000000000000000001')
expect(() => parseDecimal('-1')).toThrow(RangeError)
expect(() => parseDecimal('1e3')).toThrow(RangeError)
expect(() => parseDecimal('0.0000000000001')).toThrow(RangeError) // 13 位小数
```

- [ ] **Step 3：运行测试，确认失败。** `pnpm install && pnpm vitest run packages/pricing-data/tests/decimal.test.ts`，预期 FAIL（模块不存在）。

- [ ] **Step 4：在 `src/decimal.ts` 中实现上面四个函数。** 只用 BigInt，不出现任何 `Number` 乘除。

- [ ] **Step 5：运行测试，确认通过。** 同一命令，预期 PASS。

- [ ] **Step 6：提交。** `git add -A && git commit -m "feat(pricing-data): monorepo scaffold and fixed-point decimal"`

---

### Task 2: 峰谷时段判定

**Files:**
- Create: `packages/pricing-data/src/types.ts`、`packages/pricing-data/src/band.ts`
- Test: `packages/pricing-data/tests/band.test.ts`

**Interfaces:**
- Produces（`types.ts`，即设计文档第 5.1 节的结构，其中金额字段均为字符串）：
  - `PriceCatalog`
  - `PriceVersion`
  - `PeakWindows = { tz: string; peak: string[]; days: number[]; excludeHolidays?: string }`
  - `Rates = { input: string; cacheRead?: string; cacheWrite?: string; output: string }`
  - `Band = 'peak' | 'offpeak' | 'flat'`
  - `HolidayCalendars = PriceCatalog['holidays']`
  - `TokenCounts = { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number }`。它和官方 `TokenUsage` 在结构上兼容，所以本包不依赖 dsh。
- Produces（`band.ts`）：`resolveBand(windows: PeakWindows | undefined, holidays: HolidayCalendars, at: number): { band: Band; holidayCalendarMissing: boolean }`
  - `windows` 为 `undefined` 时返回 `flat`。
  - 先用 `Intl.DateTimeFormat('en-CA', { timeZone, hourCycle: 'h23', ... })` 把 `at` 换算成 `tz` 下的本地日期、ISO 星期和当天分钟数。
  - 星期不在 `days` 里，或者日期在节假日日历里，返回 `offpeak`。
  - 当天分钟数落在任一 `peak` 区间（左闭右开）内，返回 `peak`。
  - 配置了 `excludeHolidays`，但日历里缺少该年份时，`holidayCalendarMissing` 为 `true`，判定结果仍按普通工作日规则给出。

- [ ] **Step 1：写失败的测试。** 夹具：`W = { tz: 'Asia/Shanghai', peak: ['09:00-12:00', '14:00-18:00'], days: [1,2,3,4,5], excludeHolidays: 'CN' }`；`H = { CN: { years: { '2026': { dates: ['2026-10-01'], source: { url: 'fixture', retrievedAt: '2026-10-10' } } } } }`。日期 `2026-10-01` 只用作测试夹具，不代表真实放假安排。辅助函数：`sh = (iso: string) => Date.parse(iso + '+08:00')`。
```ts
expect(resolveBand(W, H, sh('2026-10-14T09:00:00.000'))).toEqual({ band: 'peak', holidayCalendarMissing: false })   // 周三
expect(resolveBand(W, H, sh('2026-10-14T08:59:59.999')).band).toBe('offpeak')
expect(resolveBand(W, H, sh('2026-10-14T11:59:59.999')).band).toBe('peak')
expect(resolveBand(W, H, sh('2026-10-14T12:00:00.000')).band).toBe('offpeak')
expect(resolveBand(W, H, sh('2026-10-14T14:00:00.000')).band).toBe('peak')
expect(resolveBand(W, H, sh('2026-10-14T18:00:00.000')).band).toBe('offpeak')
expect(resolveBand(W, H, sh('2026-10-17T10:00:00.000')).band).toBe('offpeak')       // 周六
expect(resolveBand(W, H, sh('2026-10-01T10:00:00.000')).band).toBe('offpeak')       // 夹具节假日
expect(resolveBand(W, H, sh('2027-03-03T10:00:00.000'))).toEqual({ band: 'peak', holidayCalendarMissing: true })
expect(resolveBand(undefined, H, sh('2026-10-14T10:00:00.000')).band).toBe('flat')
```
  再加一个用例 `it('ignores host TZ')`：先设置 `process.env.TZ = 'America/Los_Angeles'`，断言 `sh('2026-10-14T10:00:00.000')` 仍判定为 `peak`，最后恢复原来的 `TZ`。

- [ ] **Step 2：运行测试，确认失败。** `pnpm vitest run packages/pricing-data/tests/band.test.ts`，预期 FAIL。

- [ ] **Step 3：实现 `types.ts` 和 `band.ts`。**

- [ ] **Step 4：运行测试，确认通过。** 预期 PASS。

- [ ] **Step 5：提交。** `git commit -am "feat(pricing-data): peak/off-peak band resolution with weekday and holiday rules"`（新文件先 `git add`）

---

### Task 3: 价格目录、校验和 `quote()`

**Files:**
- Create: `packages/pricing-data/catalog.json`、`packages/pricing-data/src/validate.ts`、`packages/pricing-data/src/quote.ts`、`packages/pricing-data/src/index.ts`
- Create: `packages/pricing-data/README.md`（中文；说明数据来源、核实日期，以及“查不到价格就返回 null”的约定）
- Test: `packages/pricing-data/tests/quote.test.ts`、`packages/pricing-data/tests/catalog.test.ts`

**Interfaces:**
- Consumes：Task 1 的 `parseDecimal`、`costOf`、`addFixed`、`formatFixed`；Task 2 的 `resolveBand` 和各类型。
- Produces：
  - `validateCatalog(c: unknown): string[]`：返回错误列表，空列表表示合法。
  - `loadCatalog(): PriceCatalog`：读取包内的 `catalog.json`，校验不通过时抛异常。
  - `quote(catalog: PriceCatalog, q: { provider: string; model: string; usage: TokenCounts; at: number }): Quote | null`。`Quote` 的定义见设计文档第 5.1 节（含 `holidayCalendarMissing?: true`）。
  - 从 `index.ts` 统一导出以上函数和全部类型。

- [ ] **Step 1：写 `catalog.json`。** 数据来源是官方价格页截图，核实日期为 2026-10-10：
  - `schemaVersion: 1`。
  - `providers.deepseek`：`currency: "CNY"`，`unit: "per_million_tokens"`，`reasoningBilledAs: "output"`（官方 `TokenUsage` 中推理 token 已经包含在 `outputTokens` 里，不另外计费）。
  - `aliases`：`{ "deepseek-v4-flash": "deepseek-flash", "deepseek-v4-flash-vision-exp": "deepseek-flash" }`。
  - `models["deepseek-flash"]` 下一个版本：`id: "deepseek-flash@2026-10-10"`，`effectiveFrom: "2026-10-10T00:00:00+08:00"`，`windows` 同 Task 2 的 `W`，`rates.offpeak = { input: "1", cacheRead: "0.02", output: "4" }`，`rates.peak = { input: "2", cacheRead: "0.04", output: "8" }`，`source.url: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing"`，`source.retrievedAt: "2026-10-10"`，`source.note: "用户提供的官方页面截图；页面未注明生效日期"`。
  - `models["deepseek-v4-pro"]`：结构相同，`id: "deepseek-v4-pro@2026-10-10"`，`offpeak = { input: "4.5", cacheRead: "0.15", output: "13.5" }`，`peak = { input: "9.0", cacheRead: "0.30", output: "27.0" }`。
  - `holidays: { "CN": { "years": {} } }`。年份数据要等拿到国务院办公厅的放假通知后再录入，在此之前报价会带上 `holidayCalendarMissing`。

- [ ] **Step 2：写失败的测试** `quote.test.ts`（使用 `loadCatalog()`；`M = 1_000_000`；`sh` 同 Task 2）：
```ts
const u = { inputTokens: M, cacheReadTokens: M, cacheWriteTokens: 0, outputTokens: M }
expect(quote(c, { provider: 'deepseek', model: 'deepseek-flash', usage: u, at: sh('2026-10-14T10:00:00.000') }))
  .toMatchObject({ amount: '10.04', currency: 'CNY', band: 'peak', priceVersion: 'deepseek-flash@2026-10-10', holidayCalendarMissing: true })
expect(quote(c, { provider: 'deepseek', model: 'deepseek-flash', usage: u, at: sh('2026-10-14T12:30:00.000') })!.amount).toBe('5.02')
expect(quote(c, { provider: 'deepseek', model: 'deepseek-v4-pro', usage: u, at: sh('2026-10-14T10:00:00.000') })!.amount).toBe('36.3')
expect(quote(c, { provider: 'deepseek', model: 'deepseek-v4-pro', usage: u, at: sh('2026-10-17T10:00:00.000') })!.amount).toBe('18.15')
expect(quote(c, { provider: 'deepseek', model: 'deepseek-v4-flash', usage: u, at: sh('2026-10-14T10:00:00.000') })!.amount).toBe('10.04') // 别名
expect(quote(c, { provider: 'deepseek', model: 'deepseek-flash', usage: { inputTokens: 1234, cacheReadTokens: 5678, cacheWriteTokens: 0, outputTokens: 910 }, at: sh('2026-10-14T10:00:00.000') })!.breakdown)
  .toEqual({ input: '0.002468', cacheRead: '0.00022712', cacheWrite: '0', output: '0.00728', reasoning: '0' })
expect(quote(c, { provider: 'deepseek', model: 'deepseek-flash', usage: u, at: sh('2026-10-09T10:00:00.000') })).toBeNull() // 早于首个已核实价格版本
expect(quote(c, { provider: 'deepseek', model: 'no-such-model', usage: u, at: sh('2026-10-14T10:00:00.000') })).toBeNull()
expect(quote(c, { provider: 'acme', model: 'x', usage: u, at: sh('2026-10-14T10:00:00.000') })).toBeNull()
```
  另加一个用例：价格版本没有给出 `cacheWrite` 单价，但 `usage.cacheWriteTokens > 0` 时，返回 `null`。按未知单价计价就等于把这部分算成 0 元，所以宁可不报价。

  `catalog.test.ts`：
  - 断言 `validateCatalog(JSON.parse(readFileSync('catalog.json')))` 返回 `[]`。
  - 断言以下两种情况返回非空错误列表：缺少 `source.url`；同一模型的两个版本 `effectiveFrom` 和 `effectiveTo` 区间重叠。

- [ ] **Step 3：运行测试，确认失败。** `pnpm vitest run packages/pricing-data`，预期 FAIL。

- [ ] **Step 4：实现 `validate.ts`、`quote.ts`、`index.ts`。**
  - 选价格版本：先解析别名，再找满足 `effectiveFrom ≤ at < effectiveTo`（`effectiveTo` 缺省视为无穷大）的版本。
  - 选费率档：`band` 为 `flat` 时用 `rates.flat`，否则用对应时段的费率；所需的费率档不存在时返回 `null`。
  - `reasoningBilledAs: 'output'` 时 `breakdown.reasoning` 为 `'0'`；`'separate'` 时按 `rates.output` 计算并加入合计。

- [ ] **Step 5：运行测试，确认通过。** `pnpm vitest run packages/pricing-data && pnpm -F dsh-pricing-data typecheck`，预期全部 PASS，且没有类型错误。

- [ ] **Step 6：提交。** `git add -A && git commit -m "feat(pricing-data): DeepSeek catalog (verified 2026-10-10), validation and quote()"`

---

### Task 4: 类型包 `dsh-tally-api`

**Files:**
- Create: `packages/tally-api/package.json`、`packages/tally-api/tsconfig.json`、`packages/tally-api/src/index.ts`、`packages/tally-api/README.md`（中文；写明 semver 承诺：只做加法，破坏性修改必须升主版本，并且旧主版本继续维护 6 个月）
- Test: `packages/tally-api/tests/consumer.test-d.ts`

**Interfaces:**
- Produces：设计文档第 5.3 节的全部类型，并做以下调整：
  - `TallyTokens = { input: number; cacheRead: number; cacheWrite: number; output: number; reasoning?: number }`
  - `TallyEntry` 增加 `route: string`（日志里记录的原始 provider id），`provider` 字段表示映射后的价格厂商；如果没有映射，`provider` 等于 `route`。
  - `PricingService.quote` 的参数里，`usage` 类型为 `TokenCounts`，从 `dsh-pricing-data` 以 type-only 方式重新导出。`quote` 的 `provider` 参数按**路由 id** 处理：先应用 `providerRoutes` 和 `overrides`，再查价格。这样挂件可以直接把日志里的 provider 传进来。
  - 把 `UsageService.query` 的参数类型单独导出，命名为 `UsageQuery`（字段同设计文档第 5.3 节）。
  - 声明合并：`Context` 上加 `tallyPricing`、`tallyUsage`、`tallyBalance`、`tallyBudget`；`Events` 上加 `'tally/recorded'(entry: TallyEntry): void`、`'tally/balance-changed'`、`'tally/budget-crossed'`。
  - 运行时导出只有 `export {}`。
- `package.json`：`name: dsh-tally-api`；peerDependencies 为 `@deepseek-ai/cordis`（版本范围见 Global Constraints）；dependencies 为 `dsh-pricing-data: workspace:^`（只用到类型）；只发布 `lib`。

- [ ] **Step 1：写失败的类型测试** `consumer.test-d.ts`，用 vitest 的 `expectTypeOf`：
```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from 'dsh-tally-api'
declare const ctx: Context
expectTypeOf(ctx.tallyUsage.query).returns.resolves.toEqualTypeOf<UsageGroup[]>()
ctx.on('tally/recorded', (e) => { expectTypeOf(e.cost).toEqualTypeOf<Money | null>() })
expectTypeOf<TallyEntry['band']>().toEqualTypeOf<'peak' | 'offpeak' | 'flat' | null>()
```
  在 `vitest.config.ts` 里开启 `typecheck: { include: ['packages/**/*.test-d.ts'] }`。

- [ ] **Step 2：运行测试，确认失败。** `pnpm vitest run --typecheck packages/tally-api`，预期 FAIL（类型不存在）。

- [ ] **Step 3：实现 `src/index.ts`**（只写类型声明）。

- [ ] **Step 4：运行测试，确认通过。** 先跑同一命令，预期 PASS；再执行 `pnpm -F dsh-tally-api build`，确认 `lib/index.js` 中只有 `export {};`。

- [ ] **Step 5：提交。** `git add -A && git commit -m "feat(tally-api): type-only service definition package"`

---

### Task 5: 计费尝试折叠器（账本口径的核心）

**Files:**
- Create: `packages/tally/package.json`、`packages/tally/tsconfig.json`、`packages/tally/src/normalize.ts`、`packages/tally/src/attempt-fold.ts`
- Create: `packages/tally/tests/fixtures/events.ts`（事件构造器）
- Test: `packages/tally/tests/attempt-fold.test.ts`

**Interfaces:**
- Consumes：官方类型 `SessionEvent`（`@deepseek-ai/dsh-session`）、`TokenUsage`（`@deepseek-ai/dsh-llm`）。
- Produces：
  - `normalizeUsage(u: TokenUsage): { known: true; tokens: TallyTokens } | { known: false; tokens: TallyTokens }`
    - 规则和官方 `packages/llm/token-meter/src/turn-usage.ts` 里的 `normalizeUsage` 完全一致：未提供 `totalTokens` 时，缓存读和缓存写都必须存在，否则 `known: false`。
    - `known: false` 时，`tokens` 仍然尽量填写，缺失的字段填 0。这些数字只用于展示，不参与金额计算。
  - `type FoldState`，内容不对外公开，可以序列化成 JSON。
  - `initialFoldState(): FoldState`
  - `foldEvent(state: FoldState, event: SessionEvent): { state: FoldState; settled: BilledAttempt[] }`
  - `BilledAttempt = { seq: number; at: number; route: string; model: string; turn: number; step: number; usage: TokenUsage | null }`
    - `seq` 是结算这次尝试的那个事件的 `seq`，用作幂等键。
    - `at` 是这次尝试开始时的事件时间：`step/start` 或 `llm/retry-started`。
    - `route` 和 `model`：以 `assistant/message` 结算时取 `message.source`；其余情况取最近一次 `request/header` 中 `header.config` 的值。
    - `usage` 是这次尝试最后一次的用量样本；没有样本时为 `null`。

- **状态机**：沿用官方 `deriveTurnTokenUsage` 的结算规则。
  - `assistant/message` 结算一次尝试，样本优先取 `data.usage`，其次取流里最后一个 usage 块。
  - `assistant/attempt` 结算一次尝试，样本取流里的 usage 块。
  - `llm/retry` 在尝试仍处于打开状态时结算它。
  - `step/end` 在尝试仍处于打开状态、且有样本时结算它。
  - `llm/retry-started` 开启新的一次尝试。
  - **与官方的区别**：遇到不合法的生命周期序列时，官方会放弃整轮；我们只忽略出问题的那一个事件，已经结算的尝试照常保留。因为账本要按尝试逐条记账，而不是只给出整轮总数。

- [ ] **Step 1：写事件构造器** `tests/fixtures/events.ts`：
  - 导出函数：`turnStart(turn)`、`stepStart(turn, step)`、`header(provider, model)`、`message(turn, step, usage, source = { provider, model })`、`attempt(turn, step, usage)`、`retry(turn, step)`、`retryStarted(turn, step, n)`、`stepEnd(turn, step)`、`turnEnd(turn)`。
  - 再导出 `seqd(events)`：按数组顺序给事件分配 `seq = index`，`time = T0 + index * 1000`，其中 `T0 = Date.parse('2026-10-14T10:00:00+08:00')`。
  - 流里的用量块写成 `{ type: 'chunk', time, chunk: { type: 'usage', usage } }`，这正是官方 `lastAssistantStreamChunk` 读取的格式。
  - 示例用量 `U1 = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 900, cacheWriteTokens: 0 }`，`U2 = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }`。

- [ ] **Step 2：写失败的测试** `attempt-fold.test.ts`。辅助函数 `run(events)` 依次折叠全部事件，返回所有 `settled`。
  - `it('single step')`：`[turnStart(1), header('deepseek-official','deepseek-flash'), stepStart(1,1), message(1,1,U1), stepEnd(1,1), turnEnd(1)]` 产出 1 条结算，`route: 'deepseek-official'`，`model: 'deepseek-flash'`，`usage` 等于 `U1`，`at` 等于 `stepStart` 事件的 `time`，`seq` 等于 `message` 事件的 `seq`。
  - `it('retry bills both attempts')`：`stepStart, attempt(U2), retry, retryStarted(n=1), message(U1), stepEnd` 产出 2 条结算。第一条以 `assistant/attempt` 结算，`usage` 为 `U2`，`route` 来自 `header`；第二条的 `at` 等于 `retryStarted` 事件的 `time`。
  - `it('matches deriveTurnTokenUsage')`：对上面两个序列以及“同一轮里有两个 step”的序列，把我们 `normalizeUsage` 后的 `input`、`output`、`cacheRead` 按轮求和，结果必须等于官方 `@deepseek-ai/dsh-token-meter/client` 中 `deriveTurnTokenUsage(events)` 的 `uncachedInputTokens`、`outputTokens`、`cacheReadTokens`。
  - `it('truncated turn')`（Review Focus 1）：`turnStart, header, stepStart, attempt-free stream`（日志在中途截断，没有 message、stepEnd、turnEnd），产出 0 条结算，并且不抛异常。
  - `it('missing cache buckets is unknown usage')`：`normalizeUsage({ inputTokens: 3, outputTokens: 7 })` 返回 `{ known: false, tokens: { input: 3, cacheRead: 0, cacheWrite: 0, output: 7 } }`。
  - `it('ignores unknown event types')`：在序列中间插入一个 `type: 'x-plugin/whatever'` 的事件，结果和不插入时相同。
  - `it('state is JSON-serializable')`：对 `JSON.parse(JSON.stringify(state))` 继续折叠，结果和不经过序列化时相同。

- [ ] **Step 3：运行测试，确认失败。** `pnpm vitest run packages/tally/tests/attempt-fold.test.ts`，预期 FAIL。

- [ ] **Step 4：实现 `normalize.ts` 和 `attempt-fold.ts`。** `packages/tally/package.json` 的设置：
  - `name: dsh-tally`；
  - `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`；
  - peerDependencies 和 devDependencies 都包含：`@deepseek-ai/cordis`、`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-session-query`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-home-paths`；
  - devDependencies 另加 `@deepseek-ai/dsh-token-meter`（只在测试中使用）；
  - dependencies 为 `dsh-pricing-data: workspace:^` 和 `dsh-tally-api: workspace:^`。

- [ ] **Step 5：运行测试，确认通过。** 同一命令，预期 PASS。

- [ ] **Step 6：提交。** `git add -A && git commit -m "feat(tally): per-attempt billing fold matching official token-meter accounting"`

---

### Task 6: 根会话解析和 SQLite 存储

**Files:**
- Create: `packages/tally/src/root.ts`、`packages/tally/src/store.ts`
- Test: `packages/tally/tests/root.test.ts`、`packages/tally/tests/store.test.ts`

**Interfaces:**
- Produces：
  - `resolveRoot(header: Pick<SessionHeader, 'id' | 'origin' | 'parentSession'>, lookup: (id: string) => Pick<SessionHeader, 'id' | 'origin' | 'parentSession'> | undefined): string`
    - 只在 `origin === 'subagent'` 时沿 `parentSession` 向上追溯。
    - 分叉会话返回自身 id。
    - 父会话查不到时，返回最后一个查到的 id。
    - 遇到循环时停止，返回进入循环前的那个 id。
  - `class TallyStore`
    - `static open(path: string): TallyStore`：自动创建目录。`user_version` 不等于 1 时，删除所有表后重建。如果文件不是合法的 SQLite 数据库（打开或首次查询抛出 `SQLITE_NOTADB` 或 `SQLITE_CORRUPT`），先把它重命名为 `<path>.corrupt-<毫秒时间戳>`，再新建一个空库。账本可以从日志重建，所以这样处理不会丢失信息。
    - `upsertEntry(e: StoredEntry): boolean`：返回值表示是否新插入；以 `id` 为键，重复插入时什么都不做。
    - `markSessionDeleted(sessionId: string): void`
    - `setCursor(sessionId: string, c: { lastSeq: number; state: string }): void` / `getCursor(sessionId: string): { lastSeq: number; state: string } | undefined`
    - `entries(filter: { from: number; to: number; route?: string; model?: string; rootSessionId?: string; sessionIds?: string[] }): StoredEntry[]`
    - `reset(): void`
    - `close(): void`
  - `StoredEntry = { id: string; sessionId: string; rootSessionId: string; workspaceId: string | null; at: number; route: string; model: string; tokens: TallyTokens; usageKnown: boolean; deleted: boolean }`，其中 `id = sessionId + ':' + seq`。
- **表结构**：
  - `entries(id TEXT PRIMARY KEY, session_id, root_session_id, workspace_id, at INTEGER, route, model, input, cache_read, cache_write, output, reasoning, usage_known INTEGER, deleted INTEGER DEFAULT 0)`，并在 `at` 上建索引。
  - `cursors(session_id TEXT PRIMARY KEY, last_seq INTEGER, state TEXT)`。
  - 以上 SQL 都在 `store.ts` 中实现。

- [ ] **Step 1：写失败的测试。**
  - `root.test.ts`：子代理链 `c2 → c1 → root`（`c1` 和 `c2` 的 `origin` 都是 `'subagent'`），`resolveRoot(c2)` 返回 `'root'`；`origin` 不是子代理的分叉会话 `f`（`parentSession: 'root'`）返回 `'f'`；父会话缺失的链返回最后一个查到的 id；`a → b → a` 循环返回 `'a'`，并且不会死循环。
  - `store.test.ts`：数据库放在 vitest 临时目录（`mkdtempSync`）。
    - 同一个 `id` 插入两次，第二次返回 `false`，`entries()` 只有 1 行；
    - `entries({ from, to })` 遵循左闭右开；
    - 手动执行 `PRAGMA user_version = 99` 后重新 `open`，表被清空；
    - `setCursor` / `getCursor` 读写一致；
    - `markSessionDeleted` 之后，这个会话的所有账目 `deleted: true`，并且仍然出现在 `entries()` 的结果里；
    - 往数据库路径写入 `Buffer.from('not a database')` 后再 `open`：不抛异常，得到空表，同目录下出现一个 `tally.v1.sqlite.corrupt-*` 文件。

- [ ] **Step 2：运行测试，确认失败。** `pnpm vitest run packages/tally/tests/root.test.ts packages/tally/tests/store.test.ts`，预期 FAIL。

- [ ] **Step 3：实现 `root.ts` 和 `store.ts`。** 使用 `import { DatabaseSync } from 'node:sqlite'` 和预编译语句，写入在一个事务内完成。

- [ ] **Step 4：运行测试，确认通过。** 预期 PASS。

- [ ] **Step 5：提交。** `git add -A && git commit -m "feat(tally): root-session resolution and sqlite entry store"`

---

### Task 7: 定价服务和查询

**Files:**
- Create: `packages/tally/src/pricing-service.ts`、`packages/tally/src/query.ts`
- Test: `packages/tally/tests/pricing-service.test.ts`、`packages/tally/tests/query.test.ts`、`packages/tally/tests/query.perf.test.ts`

**Interfaces:**
- Consumes：`dsh-pricing-data` 的 `loadCatalog` 和 `quote`；Task 6 的 `StoredEntry`；`dsh-tally-api` 的 `UsageGroup`、`SessionUsage`、`Money`、`ProviderPriceOverride`。
- Produces：
  - `class TallyPricing implements PricingService`
    - 构造参数：`(catalog: PriceCatalog, opts: { providerRoutes: Record<string, string>; overrides: ProviderPriceOverride[] })`
    - `quoteRoute(route: string, model: string, usage: TokenCounts, at: number): Quote | null`，按以下顺序处理：
      1. 先查 `overrides`，`kind: 'manual'` 时用手填单价计价，并带上 `band: 'flat'` 和 `priceVersion: 'manual:' + route`；
      2. 再用 `providerRoutes[route]`（缺省时等于 `route`）映射到价格厂商；
      3. `kind: 'alias'` 改用目标厂商和目标模型；
      4. 最后调用 `quote()`。
    - 实现接口要求的 `quote(q)`，内部就是 `quoteRoute(q.provider, q.model, q.usage, q.at)`；`catalogVersion()` 返回 `catalog.generatedAt`；`overrides()` 返回当前配置的 overrides。
  - `aggregate(entries: StoredEntry[], pricing: TallyPricing, groupBy: UsageQuery['groupBy'], tz: string): UsageGroup[]`
    - 对每条账目：`usageKnown` 为 `false` 时，`unknownUsageCount` 加 1，不计价；否则调用 `quoteRoute`，结果为 `null` 时 `unpricedCount` 加 1，否则按币种累加到 `cost`。
    - `groupBy: 'day'` 时，分组键是 `at` 在 `tz` 下的 `YYYY-MM-DD`。
    - 结果按分组键升序排列。
  - `sessionUsage(entries: StoredEntry[], sessionId: string, pricing: TallyPricing): SessionUsage`：传入的 `entries` 是所有 `rootSessionId === sessionId` 的账目；`total` 是全部账目的汇总，`children` 按子会话 id 分组（不含根会话自己的账目）。

- [ ] **Step 1：写失败的测试。**
  - `pricing-service.test.ts`：
    - 默认 `providerRoutes = { 'deepseek-official': 'deepseek', 'deepseek-account': 'deepseek' }`。`quoteRoute('deepseek-account', 'deepseek-flash', u, 周三 10:00)` 的 `amount` 为 `'10.04'`。
    - `quoteRoute('my-gateway', 'deepseek-flash', u, ...)` 返回 `null`（Review Focus 3）。
    - 加上 override `{ provider: 'my-gateway', kind: 'alias', target: { provider: 'deepseek' } }` 后，返回 `'10.04'`。
    - 加上 override `{ provider: 'my-gateway', kind: 'manual', currency: 'USD', models: { m: { input: '1', output: '2' } } }` 后，`quoteRoute('my-gateway', 'm', { inputTokens: M, outputTokens: M, cacheReadTokens: 0, cacheWriteTokens: 0 }, at)` 返回 `{ amount: '3', currency: 'USD', band: 'flat' }`。
  - `query.test.ts`：构造 4 条账目：
    - A：周三 10:00 北京时间，`deepseek-official/deepseek-flash`，`u`，`usageKnown: true`；
    - B：同一天 12:30，其余同 A；
    - C：`my-gateway/x`，`usageKnown: true`；
    - D：`usageKnown: false`。

    断言：
    - `aggregate([A,B,C,D], p, 'model', 'Asia/Shanghai')` 中，`deepseek-flash` 组的 `cost` 为 `[{ amount: '15.06', currency: 'CNY' }]`，`requestCount` 为 2；`x` 组的 `unpricedCount` 为 1，`cost` 为 `[]`；D 所在组的 `unknownUsageCount` 为 1。
    - `aggregate([A], p, 'day', 'America/Los_Angeles')` 的分组键是 `'2026-10-13'`（Review Focus 2）。
    - `sessionUsage`：根会话 r 加上子会话 c1、c2 时，`total` 是三者之和，`children` 的长度为 2。
  - `query.perf.test.ts`（Review Focus 5）：生成 100,000 条 `deepseek-flash` 账目，时间均匀分布在 30 天内；`aggregate(..., 'day', 'Asia/Shanghai')` 的耗时要小于 1000ms（用 `performance.now()` 计时）。

- [ ] **Step 2：运行测试，确认失败。** `pnpm vitest run packages/tally/tests/pricing-service.test.ts packages/tally/tests/query.test.ts packages/tally/tests/query.perf.test.ts`，预期 FAIL。

- [ ] **Step 3：实现 `pricing-service.ts` 和 `query.ts`。** 如果性能不达标，在 `aggregate` 内按 `(route, model, 小时)` 缓存价格版本和费率档，不要改动 `quote()` 的语义。

- [ ] **Step 4：运行测试，确认通过。** 预期 PASS。

- [ ] **Step 5：提交。** `git add -A && git commit -m "feat(tally): pricing service with route mapping/overrides and usage aggregation"`

---

### Task 8: 插件入口：实时记账、回填、重建

**Files:**
- Create: `packages/tally/cordis.patch.yml`、`packages/tally/src/recorder.ts`、`packages/tally/src/usage-service.ts`、`packages/tally/src/index.ts`、`packages/tally/README.md`（中文；内容包括安装方法 `dsh plugin --profile web add dsh-tally`、配置项、口径说明、给挂件作者的接入示例）
- Test: `packages/tally/tests/recorder.test.ts`、`packages/tally/tests/usage-service.test.ts`

**Interfaces:**
- Consumes：Task 5 至 Task 7 的全部导出；官方 `ctx.sessionQuery`（`listSessions()`、`readSession(id)`）、`session/event (session, event)`、`Session.isOwnSeq(seq)`、`Session.ownEvents()`、`Session.header`；`dshHomePath`。
- Produces：
  - `class Recorder`
    - 构造参数：`(store: TallyStore, onEntry: (e: StoredEntry) => void, headers: (id: string) => SessionHeaderLike | undefined)`
    - `ingest(sessionId: string, header: SessionHeaderLike, ownEvents: readonly SessionEvent[]): number`：返回新增的账目数。
    - 处理流程：先用 `store.getCursor` 恢复折叠状态，只处理 `seq > lastSeq` 的事件；每条结算转换成 `StoredEntry`（`rootSessionId` 用 `resolveRoot` 计算；`workspaceId` 取 `header.cwd ?? null`）并 `upsertEntry`；只有新插入的账目才调用 `onEntry`；最后写回游标。
    - `SessionHeaderLike = Pick<SessionHeader, 'id' | 'origin' | 'parentSession' | 'cwd'>`
  - `class TallyUsage extends Service implements UsageService`
    - 服务名 `'tallyUsage'`；`inject: ['sessionQuery', 'tallyPricing']`。
    - 方法：`query`、`session`、`rebuild()`、`status()`。
    - 每条新账目发出一次 `'tally/recorded'` 事件，`cost` 由 `tallyPricing` 现算。
  - `class TallyPricingService extends Service`：服务名 `'tallyPricing'`，内部委托给 Task 7 的 `TallyPricing`。
  - 插件入口 `index.ts`：
    - `name = 'dsh-tally'`。
    - `Config`（Schemastery）：`providerRoutes`（默认值 `{ 'deepseek-official': 'deepseek', 'deepseek-account': 'deepseek' }`）、`overrides`（默认 `[]`）、`dbPath`（默认 `dshHomePath('tally', 'tally.v1.sqlite')`）、`backfillBatch`（默认 `20`）。
    - `apply` 依次挂载两个服务。
  - **实时路径**：`ctx.on('session/event', (session, event) => ...)`。`!session.isOwnSeq(event.seq)` 时跳过；否则调用 `recorder.ingest(session.id, session.header, session.ownEvents())`，依靠游标跳过已经处理过的事件。对同一会话的调用要串行执行。
  - **回填**：服务就绪后在后台运行，使用 `ctx.setTimeout(..., 0)` 启动，不阻塞 `apply`。
    - `listSessions()` 拿到全部会话，每批 `backfillBatch` 个调用 `readSession(id)`，把 `events.filter(e => e.seq >= inheritedEventCount)` 交给 `recorder.ingest`。
    - 单个会话出错时，记入 `status().errors` 后继续处理下一个（Review Focus 4）。
    - 处理进度写入 `status().backfill`。
    - 插件卸载时，通过 `AbortController` 中断回填。
  - **`rebuild()`**：先 `store.reset()`，再重新执行回填。
  - **已删除会话**：v1 不主动探测会话是否被删除；`markSessionDeleted` 的调用放到计划 3 实现（需要监听会话删除事件）。
  - `cordis.patch.yml`：
```yaml
- insert:
    - id: tally
      name: dsh-tally
```

- [ ] **Step 1：写失败的测试。**
  - `recorder.test.ts`：使用临时数据库和 Task 5 的夹具。
    - 同一组 `ownEvents` 先 `ingest` 一次，再追加两个事件后 `ingest` 第二次。断言 `onEntry` 被调用的次数等于实际结算的次数，并且第二次只产生新增事件对应的账目。
    - 同一组事件分别“一次性 ingest”和“逐个事件 ingest”，最终 `store.entries()` 完全相同（增量记账等于全量重建）。
    - 子代理会话的账目，`rootSessionId` 等于根会话 id。
  - `usage-service.test.ts`：用 `@deepseek-ai/cordis` 构造一个最小的 Context。挂载一个假的 `sessionQuery` 服务：
    - `listSessions()` 返回 3 个会话；
    - 其中一个会话的 `readSession` 抛出 `new Error('migration-required')`；
    - 另一个会话 `inheritedEventCount: 3`，前 3 个事件是一次已结算的尝试（属于继承部分，不应记账）。

    再挂载 `dsh-tally` 插件，等待回填完成。断言：
    - `status().errors` 的长度为 1，且 `sessionId` 正确；
    - 继承的那 3 个事件没有产生账目；
    - `query({ from: 0, to: Date.now() + 1, groupBy: 'session' })` 的分组数等于 2；
    - 对一个假的 `Session` 对象（提供 `isOwnSeq`、`ownEvents`、`header`）调用 `ctx.emit('session/event', fakeSession, ev)` 之后，`'tally/recorded'` 监听器收到 1 条账目，并且它的 `cost.amount` 为预期值；
    - `rebuild()` 之后，账目总数和重建前相同。

- [ ] **Step 2：运行测试，确认失败。** `pnpm vitest run packages/tally/tests/recorder.test.ts packages/tally/tests/usage-service.test.ts`，预期 FAIL。

- [ ] **Step 3：实现 `recorder.ts`、`usage-service.ts`、`index.ts` 和 `cordis.patch.yml`。**

- [ ] **Step 4：运行测试，确认通过。** 再跑 `pnpm test && pnpm typecheck`，预期全部 PASS，没有类型错误。

- [ ] **Step 5：提交。** `git add -A && git commit -m "feat(tally): plugin entry with live recording, backfill and rebuild"`

---

### Task 9: 在真实 dsh 中做端到端冒烟测试

**Files:**
- Create: `packages/tally/tests/e2e/headless.e2e.test.ts`、`packages/tally/tests/e2e/overlay.yml`
- Modify: 根 `package.json`，新增脚本 `"test:e2e": "vitest run --config vitest.e2e.config.ts"`；新建 `vitest.e2e.config.ts`，`include` 设为 `packages/**/tests/e2e/*.e2e.test.ts`，`testTimeout` 设为 180000。
- Modify: 根 `vitest.config.ts`，在 `exclude` 中排除 `**/e2e/**`。

**Interfaces:**
- Consumes：`@deepseek-ai/dsh@0.2.0-rc.2`（作为根 devDependency，提供 `dsh` 可执行文件）、`@deepseek-ai/dsh-llm-mock-server@0.2.0-rc.2` 的 `startMockLlmServer`，以及 Task 6 的 `TallyStore`。

- [ ] **Step 1：写测试。**
  - `overlay.yml`：
```yaml
- insert:
    - id: tally
      name: dsh-tally
```
  - 测试流程：
    1. `pnpm -F dsh-tally build`；
    2. `mkdtempSync` 一个目录作为 `DSH_HOME`；
    3. `startMockLlmServer({ port: 0, apiKey: 'mock-key', sequence: ['success'], repeatLast: true })`；
    4. 以 `env: { DSH_HOME, DEEPSEEK_BASE_URL: server.baseURL + '/v1', DEEPSEEK_API_KEY: 'mock-key' }` 执行 `execFile('pnpm', ['exec', 'dsh', '--profile', 'headless', '--patch', overlayPath, 'say hi'])`。`dsh-tally` 由 pnpm workspace 链接进根目录的 `node_modules`，所以 overlay 里按包名引用即可解析；
    5. 用 `TallyStore.open(join(DSH_HOME, 'tally', 'tally.v1.sqlite'))` 打开数据库。

    断言：
    - 进程退出码为 0；
    - `entries({ from: 0, to: Date.now() + 1 })` 至少有 1 条；
    - 第一条的 `route` 为 `'deepseek-official'`，`model` 为 `'deepseek-flash'`，`tokens.input` 为 `3`（mock 服务器返回的固定值）。

    回填测试：记下第一次运行后的账目 `id` 集合 S1，删除数据库文件，然后用同样的环境再跑一次 headless（任务为 `'say hi again'`），等进程退出后重新打开数据库。断言：账目 `id` 集合包含 S1 的全部元素（来自回填），并且比 S1 至少多 1 条（来自第二次运行的实时记账）。headless 进程在任务结束后就退出，所以 `index.ts` 的回填必须在宿主 dispose 之前完成当前这一批。如果这条断言因为进程退出太早而失败，就在插件里监听宿主的 dispose，等当前批次写完再退出；不要在测试里加 sleep。
  - **说明**：mock 服务器返回的用量没有缓存字段，所以这条账目大概率是 `usageKnown: false`。这里不对 `usageKnown` 的值做断言，只检查一致性：如果 `usageKnown` 为 `true`，那么 `tallyPricing` 的报价不能是 `null`。

- [ ] **Step 2：运行测试。** `pnpm test:e2e`，预期 PASS。如果失败，先按 `superpowers:systematic-debugging` 找到根因再修，常见原因是 overlay 解析路径或 peer 依赖解析。不要靠放宽断言让测试通过。

- [ ] **Step 3：验证插件能通过官方命令安装。**
  - 执行 `pnpm -F dsh-tally build && DSH_HOME=$(mktemp -d) pnpm exec dsh plugin --profile demo add ./packages/tally`，预期成功，并打印出把它加入组合包列表的信息；
  - 执行 `DSH_HOME=<同一目录> pnpm exec dsh --profile demo --dump-config | grep -A2 "dsh-tally"`，预期能看到 `# == dsh-tally` 这一层，以及 `id: tally`。

- [ ] **Step 4：提交。** `git add -A && git commit -m "test(tally): end-to-end smoke against real dsh headless with mock LLM"`

---

## 计划 1 完成标准

- `pnpm test`、`pnpm typecheck`、`pnpm test:e2e` 全部通过。
- 在真实的 dsh 0.2.0-rc.2 上，headless 运行一轮对话后，账本里有正确的厂商、模型和 token 数，重建前后的结果一致。
- 设计文档里的以下要求已有实现并有测试覆盖：
  - 第 5.1 节：价格数据、峰谷时段、别名、`null` 语义、十进制精度；
  - 第 5.2 节：按尝试记账、重试、分叉前缀、子代理归属、用量未知、回填、重建；
  - 第 5.3 节中 `tallyPricing` 和 `tallyUsage` 的部分；
  - 第 6 节错误处理表中与本计划相关的各行。

## 留给后续计划的事项

- **计划 2**：`tallyBalance` 和 `dsh-tally-balance-deepseek`（需要先核实 DeepSeek 余额接口）、`tallyBudget`。
- **计划 3**：Remote API 的 `tally` 命名空间、`dsh-tally-ui`、会话删除时调用 `markSessionDeleted`、在设置页编辑 overrides。
- **计划 4**：对账工具、中国法定节假日数据的录入（需要国务院办公厅的放假通知作为来源）、其他厂商的价格数据、DeepSeek 历史价格的补录、兼容矩阵 CI、npm 发布、接入 PR。
