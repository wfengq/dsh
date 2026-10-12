# dsh-tally 余额与预算（计划 2/4）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `dsh-tally` 中实现 `ctx.tallyBalance`（余额注册表、缓存、刷新策略）和 `ctx.tallyBudget`（预算存储、周期计算、80%/100% 提醒），并新增 `dsh-tally-balance-deepseek` 包，为 `deepseek-official`（API key）和 `deepseek-account`（账号登录）两个路由提供余额查询。

**Architecture:** 余额和预算两个服务放在 `dsh-tally` 包里，不读凭据，也不联网。`dsh-tally-balance-deepseek` 是一个独立的小插件，只负责读凭据和请求 DeepSeek 接口，再通过 `ctx.tallyBalance.register` 注册给余额服务。读凭据加联网会触发 dsh-trust-check 的红线，这样设计就把红线集中在这一个小包里。预算存放在 `budgets.json` 中，不放进可重建的账本数据库。

**Tech Stack:** 与计划 1 相同。另外新增根目录 devDependency `dsh-trust-check@0.2.1`，用于自检。

**Spec:** `docs/superpowers/specs/2026-10-10-dsh-tally-design.md`（第 4 节，以及 §5.4、§5.5）

**前置条件:** 计划 1 已完成（PR wfengq/dsh#1）。本计划在同一分支上继续开发。

## Global Constraints

- 新包名为 `dsh-tally-balance-deepseek`，目录 `packages/balance-deepseek`；服务名为 `tallyBalance`、`tallyBudget`；事件名为 `tally/balance-changed`、`tally/budget-crossed`。
- `BalanceService` 的 `provider` 参数一律是**路由 id**（例如 `deepseek-official`、`deepseek-account`）。
- 包约定与计划 1 一致：`"type": "module"`；`engines.node` 为 `">=22.19.0"`；MIT 协议，`files` 中包含 `LICENSE`；peer 依赖范围为 `@deepseek-ai/cordis` `">=4.0.4-0 <4.1.0-0"`、`@deepseek-ai/schemastery` `">=3.18.4-0 <3.19.0-0"`、`@deepseek-ai/dsh-*` `">=0.2.0-0 <0.3.0-0"`；dev 依赖固定为 `4.0.4` / `3.18.4` / `0.2.0-rc.2`。
- 金额一律是十进制字符串；计算只用 BigInt，**禁止浮点数**。余额查询失败时**不得显示 0**：返回上一次成功的快照并标记 `stale: true`；从未成功过时返回 `wallets: []` 并附带 `error`。
- `dsh-tally` 包内不得出现读凭据或网络请求；这两件事只允许出现在 `dsh-tally-balance-deepseek` 里。API key 不得出现在任何错误信息、日志或快照中。
- 预算文件 `dshHomePath('tally', 'budgets.json')`，写入必须原子化（先写临时文件，再 rename）。
- 余额自动刷新：去抖 3000 ms，同一路由两次自动刷新之间至少间隔 60000 ms；手动 `refresh()` 立即执行，不受间隔限制；同一路由同时只允许一个请求在途。
- 预算提醒：每个预算在每个周期内，阈值 0.8 和 1 各只提醒一次；回填和重建不触发提醒；只累计与预算同币种的费用。
- 代码标识符和注释用英文，面向用户的文档用中文。

## Review Focus

1. **余额查询失败**（网络错误、401、返回内容格式不对）：不能显示 0，要保留上一次的值并标记过期，错误信息里不能出现 key（Task 1 和 Task 5 有对应测试）。
2. **对同一路由并发刷新**：两个 `refresh()` 同时调用时，只能发出一个请求，两个调用拿到同一个结果（Task 1 测试）。
3. **重启后或同时到达多条账目时，预算提醒不能重复**：已提醒的状态要持久化，评估要串行执行（Task 3 测试）。
4. **账号钱包的金额带指数写法或为负数**（例如 `0E-16`、`-1.5`）：必须正确规范化，不能抛异常，也不能算错合计（Task 4 测试）。
5. **宿主时区和预算周期**：在有夏令时的时区里，日或月的边界跨越夏令时切换时，周期起止时间仍然正确（Task 2 测试）。

---

### Task 1: 余额服务 `TallyBalance`

**Files:**
- Create: `packages/tally/src/balance-service.ts`
- Modify: `packages/tally/src/index.ts`（挂载服务，新增配置项 `balanceDebounceMs` 默认 3000、`balanceMinIntervalMs` 默认 60000、`balanceTimeoutMs` 默认 10000，并导出 `TallyBalance`）
- Test: `packages/tally/tests/balance-service.test.ts`

**Interfaces:**
- Consumes：`dsh-tally-api` 中的 `BalanceService`、`BalanceSnapshot`、`BalanceFetcher`、`Wallet`、`TallyEntry`；事件 `tally/recorded`（只在实时记账时发出，由计划 1 保证）。
- Produces：`class TallyBalance extends Service implements BalanceService`。
  - 服务名 `'tallyBalance'`，不注入其他服务。
  - 构造参数 `(ctx, config: { debounceMs: number; minIntervalMs: number; timeoutMs: number })`。
  - `register(route, fetcher)`：同一路由已有 fetcher 时抛出 `Error('tally: balance provider already registered: ' + route)`。返回的 dispose 函数会移除 fetcher，同时清掉该路由的缓存和定时器，并中止在途请求。
  - `get(route)`：有缓存就返回缓存；没有缓存但有 fetcher 时，等同于调用 `refresh(route)`；没有 fetcher 时返回 `null`。
  - `refresh(route)`：
    - 没有 fetcher 时返回 `null`。
    - 已有在途请求时，直接返回同一个 Promise。
    - 否则调用 fetcher，传入一个在 `timeoutMs` 后中止的 `AbortSignal`，或者在服务卸载时中止。
    - 成功时快照为 `{ provider: route, wallets, fetchedAt: Date.now(), stale: false }`。如果和上一次快照的 `wallets` 不同，或者上一次是 `stale` 状态，就发出 `'tally/balance-changed'`。
    - 失败时：有上一次成功的快照，就返回 `{ ...prev, stale: true, error }`；没有，就返回 `{ provider: route, wallets: [], fetchedAt: Date.now(), stale: true, error }`。`error` 取异常的 `message`。失败快照同样写入缓存并发出事件。
  - 自动刷新：监听 `'tally/recorded'`，如果 `entry.route` 注册了 fetcher，就为该路由安排一次 `debounceMs` 的去抖刷新。触发时，如果距离上次**自动**刷新开始还不到 `minIntervalMs`，就推迟到“上次开始时间 + minIntervalMs”再执行。
  - 卸载服务时，中止所有在途请求并清除所有定时器。

- [ ] **Step 1：写失败的测试。** 用 vitest fake timers，加上一个最小的 cordis Context（写法参照 `usage-service.test.ts`）。用例如下：
  - `get` 在没有 fetcher 时返回 `null`。
  - 先注册返回 `[{ kind: 'total', money: { amount: '86.2', currency: 'CNY' } }]` 的 fetcher；`refresh` 返回 `stale: false`，并且发出一次 `balance-changed`。
  - 两个 `refresh` 同时调用时，fetcher 只被调用 1 次，两个调用得到同一个结果（Review Focus 2）。
  - fetcher 先成功一次再抛出 `new Error('HTTP 503')`，第二次快照是 `stale: true`、`error: 'HTTP 503'`，`wallets` 仍是上一次的值（Review Focus 1）。
  - 从未成功过就失败时，返回 `wallets: []`，`stale: true`。
  - 同一路由重复 `register` 时抛异常；调用 dispose 后，`get` 返回 `null`。
  - 自动刷新：在 t=0 发出一条 `route: 'r'` 的 `tally/recorded`，3000 ms 后 fetcher 被调用 1 次；t=10s 再发一条，13s 时不调用，到 60s 时才第 2 次调用。
  - fetcher 永不返回时，过 `timeoutMs` 后 signal 被中止，结果是 `stale: true`。
  - 卸载服务后，在途请求的 signal 处于 aborted 状态。

- [ ] **Step 2：运行 `pnpm vitest run packages/tally/tests/balance-service.test.ts`，预期 FAIL。**
- [ ] **Step 3：实现 `balance-service.ts`，修改 `index.ts`。**
- [ ] **Step 4：重新运行，预期 PASS；再运行 `pnpm test && pnpm typecheck`，全部通过。**
- [ ] **Step 5：提交。** `git commit -m "feat(tally): balance registry with caching, stale snapshots and debounced refresh"`

---

### Task 2: 预算周期计算和预算文件

**Files:**
- Create: `packages/tally/src/period.ts`、`packages/tally/src/budget-file.ts`
- Test: `packages/tally/tests/period.test.ts`、`packages/tally/tests/budget-file.test.ts`

**Interfaces:**
- Produces：
  - `periodBounds(period: 'day' | 'month', at: number, tz: string): { start: number; end: number }`：返回 `at` 所在的本地自然日或自然月的 `[start, end)`，单位为 epoch 毫秒。用 `Intl.DateTimeFormat` 求本地日期，再通过二分或迭代找到本地零点对应的 UTC 时刻，这样夏令时也能正确处理。
  - `class BudgetFile`
    - `static load(path: string): BudgetFile`：文件不存在时得到空状态；JSON 损坏时把文件重命名为 `<path>.corrupt-<毫秒>` 并从空状态开始，同时把原因记到 `loadError: string | undefined`。
    - `budgets(): Budget[]`（返回副本）
    - `put(b: Budget): void`
    - `delete(id: string): boolean`
    - `fired(budgetId: string, periodStart: number): Array<0.8 | 1>`
    - `markFired(budgetId: string, periodStart: number, t: 0.8 | 1): void`：周期变化时，旧周期的已提醒记录被覆盖。
    - 每次修改都立即原子写盘：先写 `<path>.tmp-<pid>`，再 `renameSync`。
  - 文件格式：`{ "version": 1, "budgets": Budget[], "fired": Record<string, { periodStart: number; thresholds: Array<0.8 | 1> }> }`。
  - `validateBudget(b: unknown): string[]`：检查以下几项，返回错误列表：
    - `id` 是非空字符串；
    - `period` 是 `'day'` 或 `'month'`；
    - `scope.workspaceId` 不存在或是非空字符串；
    - `limit.currency` 是 `'CNY'` 或 `'USD'`；
    - `limit.amount` 能被 `parseDecimal` 解析且大于 0。

- [ ] **Step 1：写失败的测试。**
  - `period.test.ts`：
    - `periodBounds('day', Date.parse('2026-10-14T10:00:00+08:00'), 'Asia/Shanghai')` 返回 `{ start: Date.parse('2026-10-14T00:00:00+08:00'), end: Date.parse('2026-10-15T00:00:00+08:00') }`。
    - `month` 周期在 2026-10-31T23:59+08:00 时，`end` 为 2026-11-01T00:00+08:00。
    - `America/New_York`，2026-11-01 是夏令时结束日，当天有 25 小时：`end - start === 25 * 3600_000`（Review Focus 5）。
    - `America/New_York`，2026-03-08 当天只有 23 小时。
  - `budget-file.test.ts`：
    - 加载不存在的文件，得到空状态；
    - `put` 之后重新 `load`，内容一致；
    - `markFired` 之后重新 `load`，已提醒记录仍在；
    - 用新的 `periodStart` 调用 `markFired`，会覆盖旧周期的记录；
    - 文件内容是坏 JSON 时，产生 `.corrupt-` 文件，得到空状态，`loadError` 有值；
    - `validateBudget` 对 `limit.amount: '0'`、`'-1'`、`'1e3'` 和 `period: 'week'` 都返回非空错误列表。

- [ ] **Step 2：运行测试，预期 FAIL。** `pnpm vitest run packages/tally/tests/period.test.ts packages/tally/tests/budget-file.test.ts`
- [ ] **Step 3：实现 `period.ts` 和 `budget-file.ts`。**
- [ ] **Step 4：重新运行，预期 PASS。**
- [ ] **Step 5：提交。** `git commit -m "feat(tally): budget periods with DST-safe bounds and atomic budget file"`

---

### Task 3: 预算服务 `TallyBudget`

**Files:**
- Create: `packages/tally/src/budget-service.ts`
- Modify: `packages/tally/src/index.ts`（挂载服务；新增配置项 `budgetPath`，默认 `dshHomePath('tally','budgets.json')`，在 `apply` 时解析；新增 `timeZone`，默认取 `Intl.DateTimeFormat().resolvedOptions().timeZone`）
- Modify: `packages/tally/README.md`（新增“余额”和“预算”两节，中文）
- Test: `packages/tally/tests/budget-service.test.ts`

**Interfaces:**
- Consumes：Task 2 的 `periodBounds`、`BudgetFile`、`validateBudget`；`ctx.tallyUsage.query`；`dsh-pricing-data` 的十进制工具函数。
- Produces：`class TallyBudget extends Service implements BudgetService`。
  - 服务名 `'tallyBudget'`，`inject: ['tallyUsage']`。
  - 构造参数 `(ctx, config: { path: string; timeZone: string })`。
  - `set(b)`：先校验，不合法时抛出 `Error('tally: invalid budget: ' + errors.join('; '))`，合法则写入文件。
  - `list()`：返回副本。
  - `remove(id)`：删除预算。
  - `status()`：返回 `{ errors: string[] }`，包含加载时的错误。
  - 提醒逻辑：监听 `'tally/recorded'`（只在实时记账时发出）。仅当 `entry.cost` 不为 `null` 时，把检查任务放进一条串行 Promise 链。对每个预算：
    1. 如果 `scope.workspaceId` 存在，且不等于 `entry.workspaceId`，跳过；
    2. 如果 `limit.currency` 不等于 `entry.cost.currency`，跳过；
    3. 用 `periodBounds(period, entry.at, timeZone)` 求出周期；
    4. 用 `tallyUsage.query({ from: start, to: end, groupBy: 'day', filter: workspaceId 存在时带上 })` 查询，把同币种的 `cost` 用 BigInt 求和，得到 `spent`；
    5. 对阈值 0.8 和 1：如果 `spent ≥ limit × t`，且本周期还没提醒过这个阈值，就先 `markFired`，再发出 `'tally/budget-crossed'`，内容为 `{ budgetId, threshold, spent, limit, periodStart: start }`。

- [ ] **Step 1：写失败的测试。** 构造一个假的 `tallyUsage` 服务，`query` 返回可控的 `cost`；用临时目录存放文件。用例如下：
  - 预算上限 10 CNY，按日计算。`spent` 为 7 时不提醒；为 8 时提醒一次 0.8；再来一条 9 时不再提醒；到 10 时提醒 1。
  - `spent` 一次从 0 跳到 12 时，0.8 和 1 两个提醒都发出，顺序是先 0.8 后 1。
  - 提醒过 0.8 之后重建服务（重新 `load` 文件），再来一条账目，不会重复提醒 0.8（Review Focus 3）。
  - 同时连续发出 5 条 `tally/recorded`，每个阈值最多只提醒一次（Review Focus 3）。
  - `scope.workspaceId: 'w1'` 的预算会忽略 `workspaceId: 'w2'` 的账目。
  - USD 预算忽略 CNY 费用。
  - 第二天的账目会进入新周期，可以再次提醒。
  - 不合法的预算调用 `set` 会抛异常，文件不变。
  - `cost: null` 的账目不触发查询。

- [ ] **Step 2：运行 `pnpm vitest run packages/tally/tests/budget-service.test.ts`，预期 FAIL。**
- [ ] **Step 3：实现服务，修改 `index.ts` 和 README。**
- [ ] **Step 4：重新运行，预期 PASS；再运行 `pnpm test && pnpm typecheck`，全部通过。**
- [ ] **Step 5：提交。** `git commit -m "feat(tally): budget service with once-per-period 80%/100% alerts"`

---

### Task 4: DeepSeek 余额数据的解析

**Files:**
- Create: `packages/balance-deepseek/package.json`、`tsconfig.json`、`LICENSE`、`src/parse.ts`
- Test: `packages/balance-deepseek/tests/parse.test.ts`

**Interfaces:**
- Produces（`src/parse.ts`，纯函数，不依赖 dsh）：
  - `normalizeDecimal(s: string): string`
    - 接受和官方账号平台相同的写法：`/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i`；
    - 输出不带指数、不带多余前导零和尾随零的十进制字符串，零统一输出 `"0"`，负数保留 `-`；
    - 不合法时抛出 `RangeError`；
    - 实现只用 BigInt 和字符串运算。
  - `addDecimals(a: string, b: string): string`：两个已规范化的值精确相加，支持负数。
  - `parseApiBalance(json: unknown): Wallet[]`
    - 期望的格式是 `{ is_available: boolean, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }`；
    - 对每个 `currency` 为 `CNY` 或 `USD` 的条目，依次输出 `topup`、`granted`、`total` 三个钱包；
    - 其他币种跳过；
    - 结构不对时抛出 `Error('DeepSeek balance: unexpected response shape')`。
  - `parseAccountBalance(r: { value: readonly { currency, balance }[]; bonusWallets: readonly { currency, balance }[] }): Wallet[]`：同一币种的 `value` 求和作为 `topup`，`bonusWallets` 求和作为 `granted`，二者相加作为 `total`。
- `package.json`：
  - `name: dsh-tally-balance-deepseek`；
  - `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`（`cordis.patch.yml` 在 Task 5 创建）；
  - `files: ["lib", "cordis.patch.yml", "README.md", "LICENSE"]`；
  - dependencies：`dsh-tally-api: workspace:^`；
  - peer 和 dev 依赖：`@deepseek-ai/cordis`、`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-credentials`、`@deepseek-ai/dsh-deepseek-account`（先确认这两个包在 npm 上的真实包名，以官方仓库各自 `package.json` 的 `name` 为准）。

- [ ] **Step 1：写失败的测试。**
  - `normalizeDecimal`：
    - `'0E-16'` 得到 `'0'`；
    - `'1.50'` 得到 `'1.5'`；
    - `'.5'` 得到 `'0.5'`；
    - `'5.'` 得到 `'5'`；
    - `'1e3'` 得到 `'1000'`；
    - `'1.25E-2'` 得到 `'0.0125'`；
    - `'-1.50'` 得到 `'-1.5'`；
    - `'-0.0'` 得到 `'0'`；
    - `'abc'` 和 `''` 抛出 `RangeError`（Review Focus 4）。
  - `addDecimals('1.5', '-2')` 得到 `'-0.5'`。
  - `parseApiBalance`：
    - 输入 `{ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' }] }`，输出 `[{ kind: 'topup', money: { amount: '100', currency: 'CNY' } }, { kind: 'granted', … '10' }, { kind: 'total', … '110' }]`；
    - `currency` 为 `EUR` 的条目被跳过；
    - 缺少 `balance_infos` 时抛异常。
  - `parseAccountBalance`：`value` 为 `[{CNY,'60'},{CNY,'40'}]`、`bonusWallets` 为 `[{CNY,'0E-16'}]` 时，得到 topup `'100'`、granted `'0'`、total `'100'`。

- [ ] **Step 2：运行测试，预期 FAIL。** 先 `pnpm install`，再 `pnpm vitest run packages/balance-deepseek/tests/parse.test.ts`。
- [ ] **Step 3：实现 `parse.ts` 和包骨架。**
- [ ] **Step 4：重新运行，预期 PASS。**
- [ ] **Step 5：提交。** `git commit -m "feat(balance-deepseek): decimal normalization and DeepSeek balance parsers"`

---

### Task 5: `dsh-tally-balance-deepseek` 插件

**Files:**
- Create: `packages/balance-deepseek/src/index.ts`、`packages/balance-deepseek/src/fetchers.ts`、`packages/balance-deepseek/cordis.patch.yml`、`packages/balance-deepseek/README.md`（中文；说明这个包为什么会被标红、代码有多少行、只访问哪个域名）
- Test: `packages/balance-deepseek/tests/fetchers.test.ts`、`packages/balance-deepseek/tests/plugin.test.ts`

**Interfaces:**
- Consumes：`ctx.tallyBalance.register`；`ctx.credentials.resolve(ref) → { value, source } | undefined`；`ctx.deepseekAccount.getBalance(client) → AccountDetails['balance'] | null`；Task 4 的解析函数。
- Produces：
  - `apiKeyFetcher(opts: { baseURL: string; resolveKey: () => Promise<string | undefined>; fetch?: typeof fetch }): BalanceFetcher`
    - 没有 key 时抛出 `Error('DEEPSEEK_API_KEY not configured')`；
    - 请求 `new URL('/user/balance', baseURL)`，请求头 `{ Authorization: 'Bearer ' + key, Accept: 'application/json' }`，带上 `signal`；
    - 响应码不是 2xx 时抛出 `Error('DeepSeek balance: HTTP ' + status)`；
    - 正常时返回 `parseApiBalance(await res.json())`；
    - 任何错误信息里都不能包含 key。
  - `accountFetcher(opts: { getBalance: (client) => Promise<…>; version: string }): BalanceFetcher`
    - `client` 为 `{ version, locale: 'zh-CN', timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60 }`；
    - 返回 `null` 时抛出 `Error('DeepSeek account: signed out')`；
    - `status` 为 `'failed'` 时抛出 `Error('DeepSeek account: balance query failed')`；
    - 正常时返回 `parseAccountBalance(r)`。
  - 插件 `name = 'dsh-tally-balance-deepseek'`，`inject: ['tallyBalance']`。
  - `Config`：`baseURL` 默认 `'https://api.deepseek.com'`，`apiKeyRef` 默认 `'DEEPSEEK_API_KEY'`，`officialRoute` 默认 `'deepseek-official'`，`accountRoute` 默认 `'deepseek-account'`。
  - `apply`：
    - 在 `ctx.inject(['credentials'], c => …)` 中注册 `officialRoute` 的 `apiKeyFetcher`；
    - 在 `ctx.inject(['deepseekAccount'], c => …)` 中注册 `accountRoute` 的 `accountFetcher`；
    - 两处都把 `register` 返回的 dispose 交给 `c.effect` 管理，这样依赖的服务消失时会自动注销。
  - `cordis.patch.yml`：`- insert: [{ id: tally-balance-deepseek, name: dsh-tally-balance-deepseek }]`。

- [ ] **Step 1：写失败的测试。**
  - `fetchers.test.ts`：用 `node:http` 在 port 0 起一个本地 stub 服务。
    - 返回上面 Task 4 的 JSON 时，结果为三个钱包，并且 stub 收到的请求头 `authorization` 为 `'Bearer sk-test-123'`；
    - stub 返回 401 时，抛出的异常 `message` 为 `'DeepSeek balance: HTTP 401'`，并且**不包含** `'sk-test-123'`（Review Focus 1）；
    - 返回非 JSON 时抛异常，`message` 不包含 key；
    - `resolveKey` 返回 `undefined` 时，抛出 `'DEEPSEEK_API_KEY not configured'`；
    - `accountFetcher` 的三种情况：`null`、`failed`、正常。
  - `plugin.test.ts`：用最小 Context 挂载假的 `tallyBalance` 服务（记录 `register` 调用）、假的 `credentials` 服务和假的 `deepseekAccount` 服务。
    - 断言两个路由都注册了；
    - 卸载假的 `credentials` 服务后，`deepseek-official` 被注销；
    - 用 `baseURL` 指向 stub 服务，调用注册的 fetcher，能拿到余额。

- [ ] **Step 2：运行测试，预期 FAIL。**
- [ ] **Step 3：实现插件。**
- [ ] **Step 4：重新运行，预期 PASS；再运行 `pnpm test && pnpm typecheck && pnpm -r run build`，全部通过。**
- [ ] **Step 5：提交。** `git commit -m "feat(balance-deepseek): API-key and account balance providers for tallyBalance"`

---

### Task 6: dsh-trust-check 自检和端到端测试

**Files:**
- Create: `tests/trust.test.ts`（根目录）
- Modify: 根目录 `package.json`（devDependency `dsh-trust-check: 0.2.1`）、`vitest.config.ts`（`include` 加上 `tests/**/*.test.ts`）
- Create: `packages/tally/tests/e2e/fixtures/balance-probe.mjs`、`packages/tally/tests/e2e/overlay-balance.yml`
- Modify: `packages/tally/tests/e2e/headless.e2e.test.ts`（新增一个用例）

**Interfaces:**
- Consumes：`dsh-trust-check` 导出的 `collectPlugin(dir, spec)`、`auditPlugin(report)` 和 `classifyRedLine(text)`，以安装后的包为准；如果实际导出名不同，用实际名称并在报告中说明。
- `balance-probe.mjs`：一个 Cordis 插件，`inject: ['tallyBalance']`。`apply` 时调用 `ctx.tallyBalance.refresh('deepseek-official')`，把结果用 JSON 写到 `$DSH_HOME/probe-balance.json`（`DSH_HOME` 从 `process.env` 读取）。

- [ ] **Step 1：写测试。**
  - `tests/trust.test.ts`：对已构建的四个包（`packages/pricing-data`、`packages/tally-api`、`packages/tally`、`packages/balance-deepseek`）分别执行 `auditPlugin(collectPlugin(dir, 'file:' + dir))`。
    - 断言前三个包的 `redLines` 为空；
    - 断言 `balance-deepseek` 的 `redLines` 经 `classifyRedLine` 分类后**只包含** `'creds-network'`。
  - e2e 新用例：
    1. 起一个 stub HTTP 服务：`/user/balance` 返回 Task 4 的 JSON，并记录收到的 `authorization` 请求头；
    2. 生成一个 overlay，挂载 `dsh-tally`、`dsh-tally-balance-deepseek`（配置 `baseURL` 为 stub 地址）和 probe 插件，三者都按构建产物的路径引用；
    3. 用和现有用例相同的环境变量运行 headless；
    4. 断言：退出码为 0；`probe-balance.json` 中 `stale: false`，并含有 topup 100、granted 10、total 110；stub 收到的 `authorization` 为 `'Bearer mock-key'`；stderr 中没有 `ExperimentalWarning`，也没有 `failed to import`。

- [ ] **Step 2：运行 `pnpm test`（包含 trust 测试）和 `pnpm test:e2e`，预期全部 PASS。** 如果 trust 测试显示核心包出现红线，先找根因，修代码而不是放宽断言。
- [ ] **Step 3：提交。** `git commit -m "test: trust-check gate for all packages and e2e balance probe on real dsh"`

---

## 计划 2 完成标准

- `pnpm test`、`pnpm typecheck`、`pnpm test:e2e`、`pnpm test:perf` 全部通过。
- 在真实的 dsh 0.2.0-rc.2 上，余额插件通过 `ctx.tallyBalance` 返回正确的钱包数据，并且 stderr 干净。
- dsh-trust-check 检查结果：三个核心包没有红线；`dsh-tally-balance-deepseek` 只有 `creds-network` 一条红线。
- 设计文档 §5.4 和 §5.5 的全部要求都有实现，并有测试覆盖。

## 留给后续计划的事项

- **计划 3**：Remote API 的 `tally` 命名空间（包括余额和预算）、参考界面中的余额条和预算设置。
- **计划 4**：对账工具、节假日数据、其他厂商价格、npm 发布与推广。
