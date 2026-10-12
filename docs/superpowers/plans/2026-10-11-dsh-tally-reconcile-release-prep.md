# dsh-tally 对账、节假日数据、兼容性 CI 与发布准备（计划 4/4）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 录入 2026 年中国法定节假日；提供对账命令行工具 `dsh-tally reconcile`（可插拔账单解析器，先实现通用 CSV 解析器）；在 dsh 的 `latest` 和 `alpha` 两个通道上跑兼容性 CI；完成发布前的全部准备，但**不实际发布或向外部提交任何东西**。

**Architecture:**
- 节假日数据只改 `dsh-pricing-data/catalog.json`，现有的峰谷判断逻辑不变。
- 对账代码放在 `dsh-tally` 包的 `src/reconcile/` 下，通过 `package.json#bin` 暴露命令 `dsh-tally`。它只读账本数据库和本地账单文件，不经过 dsh 宿主，也不联网。
- CI 是 GitHub Actions 工作流加一个切换 dsh 版本的脚本。
- 发布准备包括：changesets 配置、包元数据、打包内容检查，以及根目录 README（包含自动生成的 dsh-trust-check 扫描结果）。

**Tech Stack:** 与计划 1–3 相同。新增根目录 devDependency `@changesets/cli`（固定到当前最新的 2.x 版本）。

**Spec:** `docs/superpowers/specs/2026-10-10-dsh-tally-design.md`（§2 准确性标准、§5.1 节假日、§7 兼容矩阵、§8 对账、§9 发布与推广，以及 2026-10-11 的两处修订：不做接入 PR、外部提交暂缓）

**前置条件:** 计划 1–3 已完成（PR wfengq/dsh#1）。本计划在同一分支上继续开发。

**本计划不包含（已与用户确认）：**
- 其他厂商价格；
- DeepSeek 专用账单解析器：等用户提供控制台账单导出样例后再补；
- DeepSeek 历史价格补录：官方公告只找到美元价格和生效时间，人民币价格无法核实，等用户提供来源后再录入；
- npm 发布、awesome 列表收录、dsh-market 提交、`dsh-pricing-data` 单独推广。

## Global Constraints

- 金额一律用十进制字符串表示，只用 BigInt 运算，**禁止浮点数**。没有价格时不得当作 0。
- 价格和节假日数据必须附带来源（`source: { url, retrievedAt, note? }`）。中国节假日以国务院办公厅放假通知为准，只收录放假日期；调休上班日不收录（按 DeepSeek“周一至周五”的字面规则处理，见设计文档 §5.1）。
- `dsh-tally` 包内不得读凭据、不得发起网络请求；对账工具只读本地文件。dsh-trust-check 结果不得变化：四个核心包没有红线，`dsh-tally-balance-deepseek` 只有 `creds-network`。
- 包约定与计划 1–3 相同：`"type": "module"`，`engines.node` 为 `">=22.19.0"`，MIT 协议，peer 依赖范围不变。
- 不得执行 `npm publish`、`changeset publish`，也不得向任何外部仓库提交内容。
- 代码标识符和注释用英文；README 和命令行输出用中文（`--json` 输出的字段名用英文）。

## Review Focus

1. **真实账单 CSV 的各种写法**：UTF-8 BOM、中文表头、带引号和逗号的字段、千分位金额（如 `"1,234.56"`）、货币符号（`¥12.30`）、CRLF 换行。都要能正确解析；无法解析的行要报告行号，不能静默丢弃（Task 2 测试）。
2. **按天归属的时区**：账单按北京时间划分日期，账本按 UTC 存储时间戳。北京时间 00:30 发生的请求必须计入当天，不能计入前一天（Task 3 测试）。
3. **只出现在一边的日期或模型**：账单有、账本没有的，以及反过来的情况，都要列出，并标明差异是 100%，不能漏掉（Task 3 测试）。
4. **差异可解释**：超出 1% 的行要列出可能原因，包括该天该模型的未定价请求数、用量未知请求数、节假日日历缺失的高峰请求数（Task 3 测试）。
5. **节假日边界**：节假日当天的高峰时段按空闲价计算；调休上班的周末仍按空闲价；尚未录入年份（2027）的工作日高峰仍带“可能高估”标记（Task 1 测试）。

---

### Task 1: 录入 2026 年中国法定节假日

**Files:**
- Modify: `packages/pricing-data/catalog.json`（`holidays.CN.years["2026"]`，以及顶层 `generatedAt`）
- Test: `packages/pricing-data/tests/holidays.test.ts`
- Modify: `packages/pricing-data/README.md`（说明节假日数据的来源和更新方式）

**Interfaces:**
- Consumes：现有的 `resolveBand`、`quote`、`validateCatalog`（无改动）。
- Produces：`holidays.CN.years["2026"] = { dates: string[], source }`。

数据如下（来源为《国务院办公厅关于2026年部分节假日安排的通知》，国办发明电〔2025〕7号，2025-11-04 发布）：
- `dates`，共 33 天，升序排列：
  - 元旦：`2026-01-01`、`2026-01-02`、`2026-01-03`；
  - 春节：`2026-02-15` 至 `2026-02-23`；
  - 清明节：`2026-04-04`、`2026-04-05`、`2026-04-06`；
  - 劳动节：`2026-05-01` 至 `2026-05-05`；
  - 端午节：`2026-06-19`、`2026-06-20`、`2026-06-21`；
  - 中秋节：`2026-09-25`、`2026-09-26`、`2026-09-27`；
  - 国庆节：`2026-10-01` 至 `2026-10-07`。
- `source`：
  - `url`：`https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm`；
  - `retrievedAt`：`2026-10-11`；
  - `note`：`国办发明电〔2025〕7号；放假日期据新华社与北京市政府网站转载全文核对；调休上班日（01-04、02-14、02-28、05-09、09-20、10-10）不收录，按 DeepSeek“周一至周五”字面规则仍为空闲时段`。

- [ ] **Step 1：写失败的测试** `holidays.test.ts`：
  - 校验：
    - `validateCatalog(loadCatalog())` 返回 `[]`；
    - 2026 年 `dates` 长度为 33、严格升序，并且每一项都匹配 `^2026-\d{2}-\d{2}$`；
  - 对 `deepseek-flash`、`usage = { input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 }` 报价，期望：

| 时刻（+08:00） | 期望 band | 期望 `holidayCalendarMissing` |
|---|---|---|
| 2026-10-05 10:00（周一，国庆） | `offpeak` | 不存在 |
| 2026-10-09 10:00（周五，普通工作日） | `peak` | 不存在 |
| 2026-10-10 10:00（周六，调休上班） | `offpeak` | 不存在 |
| 2026-02-23 15:00（周一，春节最后一天） | `offpeak` | 不存在 |
| 2026-02-24 09:00（周二，节后第一天） | `peak` | 不存在 |
| 2027-03-02 10:00（周二，2027 年未录入） | `peak` | `true` |

- [ ] **Step 2：运行，预期 FAIL。**
- [ ] **Step 3：录入数据**，更新 `generatedAt`，并在 README 中写明：每年 11 月前后国务院办公厅发布次年通知后，按同样格式追加。
- [ ] **Step 4：运行 `pnpm test && pnpm typecheck`，全部通过。**
- [ ] **Step 5：提交。** `git commit -m "data(pricing-data): CN statutory holidays for 2026"`

---

### Task 2: 账单解析：类型、CSV 解析与通用解析器

**Files:**
- Create: `packages/tally/src/reconcile/bill.ts`、`packages/tally/src/reconcile/csv-read.ts`、`packages/tally/src/reconcile/generic-csv.ts`
- Test: `packages/tally/tests/reconcile-bill.test.ts`

**Interfaces:**
- Produces（`bill.ts`）：
```ts
export interface BillRow { day: string /* YYYY-MM-DD */; model: string; amount: string /* normalized decimal */; currency: Currency; line: number }
export interface BillParseResult { rows: BillRow[]; skipped: { line: number; reason: string }[] }
export interface BillParser { id: string; describe: string; detect(text: string): boolean; parse(text: string, options: BillParserOptions): BillParseResult }
export interface BillParserOptions { columns?: Partial<Record<'day' | 'model' | 'amount' | 'currency', string>>; currency?: Currency; modelMap?: Record<string, string> }
export function registerBillParser(p: BillParser): void
export function billParsers(): readonly BillParser[]
export function pickBillParser(text: string, id?: string): BillParser   // explicit id wins; else first detect() hit; else throws Error('无法识别账单格式，请用 --format 指定')
```
- Produces（`csv-read.ts`）：`parseCsv(text: string): string[][]`，遵循 RFC 4180：去掉 BOM，支持 CRLF、带引号的字段、字段内的逗号和换行、两个连续引号转义为一个引号。
- Produces（`generic-csv.ts`）：解析器 `genericCsv`，`id: 'csv'`，`detect` 恒为 `false`，只能通过 `--format csv` 显式选用：
  - 表头列名不区分大小写，按以下别名匹配（也可用 `options.columns` 覆盖）：
    - `day`：`日期`、`date`、`day`、`账单日期`；
    - `model`：`模型`、`model`；
    - `amount`：`金额`、`费用`、`amount`、`cost`；
    - `currency`：`币种`、`currency`；
  - `currency` 列缺失时，使用 `options.currency`；两者都没有时，第一行就报错；
  - 金额：去掉货币符号（`¥`、`￥`、`$`）、千分位逗号和空白，再用 dsh-pricing-data 的 `parseAmount` 规范化，结果只用字符串表示；
  - `day` 接受 `YYYY-MM-DD`、`YYYY/MM/DD` 和 `YYYY-MM-DD HH:mm[:ss]`，统一取日期部分，输出 `YYYY-MM-DD`；
  - `model` 先经过 `options.modelMap` 映射；
  - 无法解析的行放进 `skipped`，记录行号（1 起计，表头为第 1 行）和原因，不抛异常；
  - 模块加载时注册自身。

- [ ] **Step 1：写失败的测试**（Review Focus 1）：
  - `parseCsv`：
    - 输入 `'﻿a,b\r\n"x,1","he said ""hi"""\r\n'`，得到 `[['a','b'],['x,1','he said "hi"']]`；
    - 字段内的换行被保留。
  - 通用解析器：
    - 表头 `日期,模型,金额,币种`，数据行 `2026/10/09,deepseek-flash,"¥1,234.50",CNY`，得到 `{ day: '2026-10-09', model: 'deepseek-flash', amount: '1234.5', currency: 'CNY', line: 2 }`；
    - 金额为 `abc` 的行进入 `skipped`，`line` 为 3；
    - 没有币种列，且传入 `{ currency: 'CNY' }` 时，可以正常解析；两者都没有时抛出异常，异常信息包含“币种”；
    - `modelMap: { 'deepseek-chat': 'deepseek-flash' }` 生效；
    - `columns: { amount: 'Total' }` 覆盖默认别名。
  - `pickBillParser('...', 'csv')` 返回通用解析器；不传 id 时抛出“无法识别账单格式”。
- [ ] **Step 2：运行，预期 FAIL。**
- [ ] **Step 3：实现。**
- [ ] **Step 4：运行 `pnpm test && pnpm typecheck`，全部通过。**
- [ ] **Step 5：提交。** `git commit -m "feat(tally): pluggable bill parsers with RFC 4180 CSV and a generic column-mapped parser"`

---

### Task 3: 对账比较、报告与命令行 `dsh-tally reconcile`

**Files:**
- Create: `packages/tally/src/reconcile/ledger.ts`、`packages/tally/src/reconcile/compare.ts`、`packages/tally/src/reconcile/report.ts`、`packages/tally/src/cli.ts`
- Modify: `packages/tally/package.json`（`"bin": { "dsh-tally": "./lib/cli.js" }`，`files` 保持包含 `lib`）、`packages/tally/README.md`（新增“对账”一节）
- Test: `packages/tally/tests/reconcile-compare.test.ts`、`packages/tally/tests/reconcile-cli.test.ts`

**Interfaces:**
- Consumes：Task 2 的 `BillRow`、`pickBillParser`；现有的 `TallyStore`（只读打开）、`TallyPricing`、`loadCatalog`、`query.ts` 中的聚合函数、`dshHomePath`。
- Produces（`ledger.ts`）：`ledgerDaily(opts: { dbPath: string; from: string; to: string /* inclusive YYYY-MM-DD */; tz: string; providerRoutes?: Record<string, string>; overrides?: ProviderPriceOverride[] }): LedgerDay[]`。
  - `LedgerDay` 为 `{ day, model, currency, amount: string, requestCount, unpricedCount, unknownUsageCount, holidayMissingCount }`。
  - `day` 按 `tz` 划分（默认 `Asia/Shanghai`）。
  - 未定价的账目计入 `unpricedCount`，不计入金额。
  - 数据库以只读方式打开；文件不存在时抛出 `Error('找不到账本数据库：' + path)`。
  - 价格配置默认与插件相同：`deepseek-official`、`deepseek-account` 两个路由映射到 `deepseek`。
- Produces（`compare.ts`）：`compare(ledger: LedgerDay[], bill: BillRow[], tolerance = '0.01'): ReconcileReport`。
  - 先把同一天、同一模型、同一币种的账单行求和，再按 `(day, model, currency)` 与账本做全外连接。
  - 每行为 `{ day, model, currency, ours: string | null, bill: string | null, diff: string, diffRatio: string | null, withinTolerance: boolean, hints: string[] }`。
  - `diff` 等于 `ours − bill`（缺失的一边按 0 计）。
  - `diffRatio` 等于 `|diff| / bill`，四舍五入到 6 位小数；`bill` 为 0 或缺失时为 `null`。
  - `withinTolerance` 在 `diffRatio <= tolerance` 时为真，只有一边有数据时一律为假。
  - `hints` 取值为 `unpriced:<n>`、`unknownUsage:<n>`、`holidayCalendarMissing:<n>`、`missingInBill`、`missingInLedger`。
  - 汇总 `totals`：按币种给出 ours、bill、diff，以及超出容差的行数。
  - 全部计算只用 BigInt。
- Produces（`report.ts`）：`formatReport(r: ReconcileReport): string`。输出中文表格：先列超出容差的行，然后是汇总，最后附一句“估算值，以账单为准”。
- Produces（`cli.ts`）：`dsh-tally reconcile --bill <file> [--format csv] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--tz Asia/Shanghai] [--db <path>] [--currency CNY] [--column day=日期 ...] [--model-map a=b ...] [--tolerance 0.01] [--json]`。
  - 用 `node:util` 的 `parseArgs` 解析参数。
  - `--from` 和 `--to` 默认取账单覆盖的日期范围。
  - 退出码：全部在容差内为 0，存在超出容差的行为 1，参数错误或文件错误为 2。
  - `--json` 输出 `ReconcileReport` 本身。
  - 文件第一行为 `#!/usr/bin/env node`。
  - 不读取任何凭据，也不联网。

- [ ] **Step 1：写失败的测试。**
  - `reconcile-compare.test.ts`：用临时数据库，通过 `TallyStore` 写入账目：
    - 两条 `deepseek-official` / `deepseek-flash` 账目，`at` 分别为 `2026-10-09T00:30+08:00`（即 UTC 10-08 16:30）和 `2026-10-09T15:00+08:00`；一条 `deepseek-v4-pro` 账目在 10-09；一条无价格路由 `foo` 的账目在 10-09。
    - 断言 `ledgerDaily({ from: '2026-10-09', to: '2026-10-09', tz: 'Asia/Shanghai' })` 中，flash 的那天包含两条账目（Review Focus 2），金额等于两次 `quote` 之和，`unpricedCount` 来自 `foo` 那条，并记在 `foo` 的模型名下。
    - `compare`：
      - 账单与账本的差异在 0.5% 以内时，`withinTolerance` 为 true；
      - 差异为 2% 时为 false，并且 `hints` 包含 `unpriced:` 或其他适用的提示（Review Focus 4）；
      - 账单多出一个模型时，该行 `ours` 为 null，带 `missingInLedger`，`withinTolerance` 为 false；反过来带 `missingInBill`（Review Focus 3）；
      - CNY 和 USD 的汇总分开计算。
  - `reconcile-cli.test.ts`：用 `node packages/tally/lib/cli.js` 运行，配合临时数据库和临时 CSV：
    - 全部吻合时退出码为 0，输出包含“汇总”；
    - 有超出容差的行时退出码为 1；
    - `--json` 的输出可以 `JSON.parse`，并且包含 `totals`；
    - 账单文件不存在时退出码为 2，stderr 包含文件路径；
    - 输出中没有 `ExperimentalWarning`。
- [ ] **Step 2：运行，预期 FAIL。**
- [ ] **Step 3：实现**，并在 README 的“对账”一节中写明：用法示例、各参数说明、退出码、1% 容差的依据（设计文档 §2）、超出容差时的提示含义，以及“DeepSeek 控制台账单的专用格式待补充，目前请用 `--format csv` 配合 `--column` 指定列名”。
- [ ] **Step 4：运行 `pnpm test && pnpm typecheck`，全部通过；再运行 `pnpm exec dsh-tally reconcile --help`，确认能输出用法。**
- [ ] **Step 5：提交。** `git commit -m "feat(tally): dsh-tally reconcile CLI comparing the ledger with a bill export"`

---

### Task 4: 兼容性 CI（dsh `latest` 与 `alpha` 两个通道）

**Files:**
- Create: `scripts/use-dsh-channel.mjs`、`.github/workflows/compat.yml`
- Test: `tests/use-dsh-channel.test.ts`
- Modify: 根目录 `package.json`（新增脚本 `"dsh:channel": "node scripts/use-dsh-channel.mjs"`）

**Interfaces:**
- Produces：`node scripts/use-dsh-channel.mjs <tag> [--registry-version <version>] [--root <dir>]`。
  - 用 `npm view @deepseek-ai/dsh@<tag> version` 取得版本号。传入 `--registry-version` 时直接使用该值，供测试使用，不联网。
  - 把根目录和 `packages/*` 下所有 `package.json` 的 `devDependencies` 中，`@deepseek-ai/dsh` 和 `@deepseek-ai/dsh-*` 的固定版本改成这个版本。peerDependencies 不改。
  - 以下两类依赖不改：`@deepseek-ai/cordis`、`@deepseek-ai/schemastery`、`@deepseek-ai/cosmokit`（它们的版本号与 dsh 不同步），以及当前值不是精确版本号的依赖。
  - 打印改动的条目数，并以 0 退出。
- `compat.yml`：
  - 触发条件：`push`（分支 `main` 和 `claude/**`）、`pull_request`、`workflow_dispatch`，以及 `schedule` cron `17 1 * * *`（每天，用来跟上 dsh 新版本）。
  - matrix 为 `channel: [latest, alpha]`，`fail-fast: false`。
  - 步骤：
    1. checkout；
    2. 用 pnpm/action-setup 安装 `10.28.0`；
    3. setup-node 使用 `22.19.0`；
    4. 运行 `node scripts/use-dsh-channel.mjs ${{ matrix.channel }}`；
    5. 运行 `pnpm install --no-frozen-lockfile`；
    6. 运行 `npx playwright install --with-deps chromium`（CI 环境没有预装浏览器）；
    7. 依次运行 `pnpm test`、`pnpm typecheck`、`pnpm test:e2e`、`pnpm test:perf`。
  - 加上 `concurrency`，同一分支同时只运行一组，新的运行取消旧的。

- [ ] **Step 1：写失败的测试** `tests/use-dsh-channel.test.ts`：在临时目录中构造根目录和两个子包的 `package.json`，以 `--registry-version 0.2.1-alpha.2 --root <tmp>` 运行脚本，断言：
  - `@deepseek-ai/dsh` 和 `@deepseek-ai/dsh-session` 的 devDependencies 变为 `0.2.1-alpha.2`；
  - `@deepseek-ai/cordis` 不变；
  - peerDependencies 不变；
  - `workspace:^` 不变；
  - 输出中报告的改动条目数正确。
- [ ] **Step 2：运行，预期 FAIL。**
- [ ] **Step 3：实现脚本和工作流。**
- [ ] **Step 4：在本地验证 alpha 通道**：
  1. 在一个临时 worktree 里运行 `node scripts/use-dsh-channel.mjs alpha`；
  2. 再依次运行 `pnpm install --no-frozen-lockfile && pnpm test && pnpm typecheck && pnpm test:e2e`；
  3. 把结果写进执行报告。

  如果 alpha 上有测试失败：先查清是 dsh 的破坏性变化还是我们的问题，把结论写进执行报告；只修我们代码里能兼容两个通道的问题，不为 alpha 降级断言。临时 worktree 中的改动不提交。
- [ ] **Step 5：运行 `pnpm test`，全部通过。**
- [ ] **Step 6：提交。** `git commit -m "ci: compatibility matrix on dsh latest and alpha channels"`

---

### Task 5: 发布前准备（不发布）

**Files:**
- Create: `.changeset/config.json`、`.changeset/README.md`、`.changeset/initial-release.md`、根目录 `README.md`、`scripts/trust-report.mjs`
- Modify: 五个包的 `package.json`（元数据）、根目录 `package.json`（devDependency `@changesets/cli`，以及脚本 `"trust:report"`、`"changeset"`）
- Test: `tests/packaging.test.ts`、`tests/trust-report.test.ts`

**Interfaces:**
- 每个包的 `package.json` 补充以下字段：
  - `description`（中文，一句话）；
  - `keywords`：`["dsh", "dsh-plugin", "deepseek", ...]`，按包的用途补充；
  - `repository`：`{ "type": "git", "url": "git+https://github.com/wfengq/dsh.git", "directory": "packages/<dir>" }`；
  - `homepage`：`https://github.com/wfengq/dsh/tree/main/packages/<dir>#readme`；
  - `bugs`：`https://github.com/wfengq/dsh/issues`；
  - `publishConfig`：`{ "access": "public" }`；
  - 版本保持 `0.1.0`。
- `.changeset/config.json`：`{ "$schema": "https://unpkg.com/@changesets/config@3.1.1/schema.json", "changelog": "@changesets/cli/changelog", "commit": false, "fixed": [], "linked": [["dsh-tally", "dsh-tally-api", "dsh-tally-ui"]], "access": "public", "baseBranch": "main", "updateInternalDependencies": "patch", "ignore": [] }`。
- `.changeset/initial-release.md`：五个包都标为 `minor`，正文为“首个公开版本”的中文说明。
- `scripts/trust-report.mjs`：
  - 对五个包的构建产物运行 `auditPlugin(collectPlugin(dir, 'file:' + dir))`；
  - 生成 Markdown 表格，列为：包、能力、红线、联网目标；
  - 写入根目录 README 中 `<!-- trust-report:start -->` 和 `<!-- trust-report:end -->` 之间的内容；
  - 带 `--check` 参数时只做比较：内容不一致就以 1 退出，并打印“README 中的扫描结果已过期，请运行 pnpm trust:report”。
- 根目录 `README.md`（中文）包括：
  - 项目简介，以及五个包的作用；
  - 安装方法：`dsh plugin --profile web add dsh-tally dsh-tally-ui dsh-tally-balance-deepseek`；
  - 版本承诺：严格 semver，只做加法；破坏性修改升主版本，旧主版本继续维护 6 个月；
  - 扫描结果表；
  - 为什么 `dsh-tally-balance-deepseek` 有一条红线：它读凭据并访问 `api.deepseek.com`，写明它的源码行数和这两个能力的代码位置；
  - 对账工具的入口；
  - “估算值，以账单为准”的说明；
  - 状态说明：尚未发布到 npm。

- [ ] **Step 1：写失败的测试。**
  - `tests/packaging.test.ts`：对每个包运行 `npm pack --dry-run --json <dir>`（在 `pnpm run build` 之后），断言：
    - 打包的文件里包含 `LICENSE`、`README.md`、`package.json` 和 `lib/` 下的入口文件；
    - 不包含 `src/`、`tests/` 和 `*.test.*`；
    - `dsh-tally` 的包里包含 `lib/cli.js`；
    - `dsh-tally-ui` 的包里包含 `lib/client.js`；
    - 每个 `package.json` 都有 `description`、`repository.directory`、`publishConfig.access === 'public'`，`keywords` 包含 `dsh-plugin`。
  - `tests/trust-report.test.ts`：
    - 运行 `node scripts/trust-report.mjs --check`，退出码为 0；
    - 生成的表格中，`dsh-tally-balance-deepseek` 一行的红线列为 `creds-network`，其余四个包为空。
- [ ] **Step 2：运行，预期 FAIL。**
- [ ] **Step 3：实现**。运行 `pnpm trust:report` 写入 README。用 `pnpm changeset status` 确认 changeset 能被识别。**不运行** `changeset version`、`changeset publish` 和 `npm publish`。
- [ ] **Step 4：运行 `pnpm test && pnpm typecheck && pnpm test:e2e`，全部通过。**
- [ ] **Step 5：提交。** `git commit -m "chore: release preparation — changesets, package metadata, packaging checks and trust report (no publish)"`

---

## 计划 4 完成标准

- `pnpm test`、`pnpm typecheck`、`pnpm test:e2e`、`pnpm test:perf` 全部通过。
- 2026 年节假日已录入，峰谷判断的测试覆盖节假日、调休日和未录入年份。
- `dsh-tally reconcile` 可以用通用 CSV 账单完成对账，输出中文报告或 JSON，退出码符合约定。
- 兼容性工作流已经写好；alpha 通道在本地验证过，结果写进执行报告。
- 五个包的元数据、打包内容和 README 扫描结果都通过测试；changeset 已准备好，但没有执行任何发布或外部提交。

## 等待用户输入的后续事项

- 用户提供 DeepSeek 控制台账单导出样例后，新增 `deepseek-console` 解析器（实现 `detect`），并补充测试。
- 用户提供带人民币价格和生效时间的官方来源后，补录 DeepSeek 历史价格版本。目前已知的线索：V4-Pro 的峰谷计价自 2026-08-16 16:00 UTC 起生效（官方公告 news260813），V4.1-Flash 的价格自 2026-09-10 04:00 UTC 起生效（官方公告 news260910）；这两条只核实到美元价格。
- 2027 年节假日通知预计 2026 年 11 月发布，发布后按 Task 1 的格式追加。
- npm 发布、awesome 列表收录、dsh-market 提交，等用户决定。
