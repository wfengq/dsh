# dsh-tally-ui 界面重设计 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 dsh-tally-ui 的设置页、费用条、每轮费用、会话累计、预算提醒和右侧栏看板在外观和信息结构上贴合 dsh 原生界面，并把跳过的旧会话合并成一行汇总。

**Architecture:** 原地重排。服务端只给 `TallyStatusView` 加一个 `routes` 字段；浏览器端 store 增加本月用量和每条预算的已用金额；界面层按 dsh 的设置卡片、公共组件和 token 重写布局，纯逻辑（预算进度、问题合并、弹窗校验）抽成独立模块先写测试。

**Tech Stack:** TypeScript、React 19（dsh 共享）、`@deepseek-ai/dsh-client-ui-primitives`、cordis、zod、vitest、Playwright（e2e）。

**Spec:** `docs/superpowers/specs/2026-10-12-dsh-tally-ui-redesign-design.md`

## Global Constraints

- 只用 `--dsw-alias-*` 语义 token；不写颜色字面量，不写主题选择器。
- 设置卡片：`border-radius: var(--dsw-radius-xl)`；`border: 0.5px solid var(--dsw-alias-settings-card-stroke)`；`background: var(--dsw-alias-settings-card-fill)`；行分隔用 0.5px 中性发丝线。
- 组件库已有的控件一律用公共组件：`Button`、`Input`、`Switch`、`SegmentedControl`、`Modal`、`Menu`、`DisclosureRow`、`Tooltip`、`HoverCard`、`StateDot`、`Toast`、`Tag`。
- 字号与行高成对出现；保留可见的键盘焦点；尊重减少动态效果偏好。
- 金额永远是定点字符串；查不到价格时显示"未定价"，绝不显示 ¥0。
- 公开接口只做加法：`TallyStatusView` 只新增 `routes: string[]`，不改不删其他字段。
- 浏览器端产物只能 `require` 共享模块表里的模块，`scripts/check-client-bundle.mjs` 必须通过。
- 文案中英文都要提供（locale `zh`、`en`），`tests/locales.test.ts` 检查两边键一致。
- 提交信息不写模型名；结尾加两行：`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` 和 `Claude-Session: https://claude.ai/code/session_01DQ9WQ3XtFuXUmMKkNbGhZ6`。

## 计划层面的裁定（相对 spec 的细化）

- **CSS Modules**：`packages/tally-ui/tsdown.config.ts` 的 CSS 插件只是把原始 CSS 文本注入成 `<style>`，不做类名哈希，所以浏览器端产物不支持 CSS Modules。按 spec §3 的退路，继续使用带 `dsh-tally-` 前缀的全局类名。执行时在 ledger 里记一条 Ruling。
- **费用条按宽度省略**：用 CSS 容器查询实现（`container-type: inline-size` 加 `@container` 规则），不写 JS 测量。因此 spec §8 里"省略顺序"的单元测试改由 e2e 在窄视口下检查（Task 7）。
- **看板时间范围**：spec 规定为 7 天 / 30 天 / 本月，从 `RANGES` 中去掉 `today`，因为概览卡片已经显示今日。
- **打开看板**：通过可选注入的 `ctx.sidebarRight.openTab('tally.dashboard', { params })` 实现。dsh 没有这个服务时，点击不做任何事，只保留悬停详情。

## Review Focus

1. 没有任何预算，或预算币种和实际花费的币种不同（例如预算 USD，花费只有 CNY）时：已用金额按 0 计，不能报错，也不能显示"未定价"。（Task 2）
2. 账本还在补记（backfill）或 `hello` 重连期间：本月和预算已用金额要随 `generation` 重新拉取，不能停在旧值。（Task 2）
3. `routes` 为空（没有 llm 服务、账本也是空的）时：价格覆盖弹窗的路由下拉显示"暂无可选路由"，保存按钮禁用。（Task 4）
4. 问题合并：既有会话读取失败、又有预算文件错误时，两类各占一行，互不吞掉。（Task 4）
5. 从会话标题栏点进看板时，如果当前会话不在前 10 名，必须自动展开"显示全部"再高亮，不能高亮不到。（Task 6）

---

### Task 1: `TallyStatusView.routes`

**Files:**
- Modify: `packages/tally-api/src/index.ts`（`TallyStatusView`）
- Modify: `packages/tally/src/remote/contract.ts`（status 的 zod schema）
- Modify: `packages/tally/src/remote/service.ts`（`statusView()`、`static inject`）
- Test: `packages/tally/tests/remote.test.ts`（如果 status 的测试在别的文件，就加在那个文件里）

**Interfaces:**
- Produces: `TallyStatusView.routes: string[]`，内容是 dsh 已注册路由（`ctx.llm.listProviders()` 里每项的 `id`）与账本里出现过的路由的并集，去重后按字典序排序。

- [ ] **Step 1: 写失败的测试** `status lists configured and recorded routes, deduplicated and sorted`

  构造一个测试环境：llm 服务的 `listProviders()` 返回 `[{ id: 'deepseek', name: 'DeepSeek' }, { id: 'b-route', name: 'B' }]`，账本里有 route 为 `deepseek` 和 `a-route` 的记录。

  ```ts
  expect((await remote.status()).routes).toEqual(['a-route', 'b-route', 'deepseek'])
  ```

  再写一个用例：没有 llm 服务、账本也是空的时，`routes` 等于 `[]`。

- [ ] **Step 2: 运行测试，确认失败**

  Run: `pnpm vitest run packages/tally/tests -t "routes"`
  Expected: FAIL（`routes` 为 undefined）

- [ ] **Step 3: 实现**

  - 在 `TallyStatusView` 中加 `/** Routes known to dsh (registered LLM providers) or seen in the ledger, sorted. */ routes: string[]`。
  - contract 中加 `routes: z.array(z.string())`。
  - `static inject` 改成对象形式：`{ required: ['tallyUsage', 'tallyPricing', 'tallyBalance', 'tallyBudget'], optional: ['llm'] }`。
  - `statusView()` 中：账本路由取自 `this.usage().query({ from: 0, to: Number.MAX_SAFE_INTEGER, groupBy: 'provider' })` 各组的 `key`。先确认 `groupBy: 'provider'` 的 key 是 route；如果它是映射后的 vendor，就改为在 store 上加 `distinctRoutes(): string[]`（`SELECT DISTINCT route FROM entries`），并记一条 Ruling。与 `ctx.llm?.listProviders().map(p => p.id) ?? []` 合并，去重后排序。

- [ ] **Step 4: 运行测试，确认通过**

  Run: `pnpm vitest run packages/tally/tests`
  Expected: PASS（包括原有的 status 测试）

- [ ] **Step 5: 提交** `feat(tally): list known routes in the status view`

---

### Task 2: 浏览器端数据——本月用量和预算进度

**Files:**
- Create: `packages/tally-ui/src/client/budget-progress.ts`
- Modify: `packages/tally-ui/src/client/store.ts`
- Test: `packages/tally-ui/tests/budget-progress.test.ts`、`packages/tally-ui/tests/store.test.ts`

**Interfaces:**
- Consumes: `Budget`、`Money`、`UsageGroup`（来自 dsh-tally-api）
- Produces:
  - `export type BudgetTone = 'normal' | 'warn' | 'over'`
  - `budgetRatio(spent: Money, limit: Money): number`：两者币种相同，返回 `spent / limit`，用定点运算后再转成 number
  - `budgetTone(ratio: number): BudgetTone`：`< 0.8` → normal，`< 1` → warn，`>= 1` → over
  - `spentIn(group: UsageGroup | null, currency: Currency): Money`：取该币种的金额；没有这个币种时返回 `{ amount: '0', currency }`
  - `pickDockBudget(budgets: readonly Budget[], spend: Readonly<Record<string, Money>>): { budget: Budget; spent: Money; ratio: number } | null`：返回比例最高的预算；比例相同时优先 `period === 'day'`；budgets 为空时返回 `null`
  - `TallyStore.month: Snapshot<UsageGroup | null>`：本地自然月的用量
  - `TallyStore.budgetSpend: Snapshot<Readonly<Record<string, Money>>>`：按 budget id 记录本周期的已用金额

- [ ] **Step 1: 写失败的测试**（`budget-progress.test.ts`）

  ```ts
  test('budgetTone thresholds', () => {
    expect(budgetTone(0.79)).toBe('normal'); expect(budgetTone(0.8)).toBe('warn')
    expect(budgetTone(0.999)).toBe('warn'); expect(budgetTone(1)).toBe('over')
  })
  test('budgetRatio uses fixed point', () => {
    expect(budgetRatio({ amount: '3.2', currency: 'CNY' }, { amount: '10', currency: 'CNY' })).toBeCloseTo(0.32)
  })
  test('spentIn falls back to zero in the budget currency', () => {
    expect(spentIn(groupWith([{ amount: '5', currency: 'CNY' }]), 'USD')).toEqual({ amount: '0', currency: 'USD' })
    expect(spentIn(null, 'CNY')).toEqual({ amount: '0', currency: 'CNY' })
  })
  test('pickDockBudget picks the highest ratio, day first on ties', () => {
    // day 5/10 = 0.5, month 50/100 = 0.5 → day；month 90/100 = 0.9 → month
  })
  test('pickDockBudget returns null without budgets', () => { expect(pickDockBudget([], {})).toBeNull() })
  ```

  在 `store.test.ts` 中加：
  - `loads the month and each budget's spend on hello`：一个每日预算加一个带 `workspaceId: '/w'` 的每月预算。断言 `remote.query` 分别以本地今日、本月边界被调用，每月预算的调用带 `filter: { workspaceId: '/w' }`；`budgetSpend` 按 id 填好。
  - `refetches month and budget spend after recorded frames and on a new hello`

- [ ] **Step 2: 运行测试，确认失败**

  Run: `pnpm vitest run packages/tally-ui/tests/budget-progress.test.ts packages/tally-ui/tests/store.test.ts`
  Expected: FAIL（模块不存在，`month` 或 `budgetSpend` 未定义）

- [ ] **Step 3: 实现**

  - `budget-progress.ts` 复用 `src/client/dashboard/decimal.ts` 里的定点工具，不另写一份。
  - store 中新增 `localMonthStart(at, zone, monthShift)`，写法和现有的 `localMidnight` 一样。`loadMonth()` 用 `groupBy: 'day'` 查询，再把各天的结果求和，也可以用一个 key 恒定的分组；选现有工具最省事的写法。
  - `loadBudgetSpend()` 对每条预算按周期边界和 `scope.workspaceId` 发一次查询，用 `spentIn` 取预算币种的金额。
  - 两者都挂到和 `loadToday` 相同的时机：`hello`、recorded 防抖、跨午夜。跨午夜时同时重算本月；预算列表变化时重算 `budgetSpend`。

- [ ] **Step 4: 运行测试，确认通过**

  Run: `pnpm vitest run packages/tally-ui/tests`
  Expected: PASS

- [ ] **Step 5: 提交** `feat(tally-ui): load month usage and per-budget spend`

---

### Task 3: 设置页骨架 + 预算卡片 + 界面卡片

**Files:**
- Create: `packages/tally-ui/src/client/settings/Card.tsx`（`SettingsCard`、`SettingsRow`）
- Create: `packages/tally-ui/src/client/settings/BudgetDialog.tsx`
- Create: `packages/tally-ui/src/client/settings/validate.ts`
- Modify: `settings/BudgetsEditor.tsx`（改写为 `BudgetsCard`）、`settings/ElementSwitches.tsx`、`settings/Section.tsx`、`settings/settings.css`、`locales.ts`
- Modify: `packages/tally-ui/tests/support/primitives.tsx`（补上 `Menu`、`DisclosureRow`、`StateDot`、`Tooltip`、`Tag` 的测试替身）
- Test: `packages/tally-ui/tests/validate.test.ts`、`packages/tally-ui/tests/settings.client.test.tsx`

**Interfaces:**
- Consumes: `TallyStore.budgetSpend`、`budgetRatio`、`budgetTone`（Task 2）；`remote.query`（用于取工作区列表）
- Produces:
  - `SettingsCard({ title, description?, children, 'data-tally'? })`：一张卡片
  - `SettingsRow({ label, hint?, control, 'data-tally'? })`：一行，左边是名称加小字说明，右边是控件
  - `validateBudgetDraft(draft: { period: 'day' | 'month'; workspaceId: string | null; amount: string }, existing: readonly Budget[], editingId: string | null): 'invalid-amount' | 'duplicate' | null`
  - 后面的任务沿用这套 `.dsh-tally-card`、`.dsh-tally-row` 类名

- [ ] **Step 1: 写失败的测试**

  `validate.test.ts`：
  ```ts
  expect(validateBudgetDraft({ period: 'day', workspaceId: null, amount: '0' }, [], null)).toBe('invalid-amount')
  expect(validateBudgetDraft({ ..., amount: '1.234' }, [], null)).toBe('invalid-amount')
  expect(validateBudgetDraft({ ..., amount: 'abc' }, [], null)).toBe('invalid-amount')
  expect(validateBudgetDraft({ ..., amount: '10.5' }, [], null)).toBeNull()
  // 已有 { id: 'b1', period: 'day', scope: {} }：
  expect(validateBudgetDraft({ period: 'day', workspaceId: null, amount: '5' }, existing, null)).toBe('duplicate')
  expect(validateBudgetDraft({ period: 'day', workspaceId: null, amount: '5' }, existing, 'b1')).toBeNull() // 编辑自己
  ```

  `settings.client.test.tsx` 新增：
  - `budget row shows period · scope, spent / limit and a warn tone at 82%`：断言文字"每日 · 全部工作区"、"已用 ¥8.20 / ¥10.00"、"82%"，以及 `data-tone="warn"`
  - `empty budgets show the explanation and an add button`：文字"还没有设置预算。设置后，快超支时会提醒你。"
  - `add dialog saves with the picked workspace and closes`：选工作区 `/w`、金额 `20`，断言 `remote.setBudget` 收到 `{ period: 'month', scope: { workspaceId: '/w' }, limit: { amount: '20', currency: 'CNY' } }`，并且弹窗已关闭
  - `add dialog keeps open and shows the server error on failure`
  - `element switches show their hints`：5 个开关的说明文字逐字和 spec §4.2 表格一致

- [ ] **Step 2: 运行测试，确认失败**

  Run: `pnpm vitest run packages/tally-ui/tests/validate.test.ts packages/tally-ui/tests/settings.client.test.tsx`
  Expected: FAIL

- [ ] **Step 3: 实现**

  - 卡片材质照 Global Constraints。
  - 预算行的"⋯"菜单用 `Menu`，菜单项是 `edit` 和 `delete`，其中 `delete` 设 `danger: true`。
  - 弹窗用 `Modal`，弹窗内依次放：周期 `SegmentedControl`，范围下拉（`Menu`，第一项是"全部工作区"），金额 `Input` 加币种 `SegmentedControl`，底部"取消"和"保存"。
  - 工作区列表在弹窗打开时取：`remote.query({ from: 0, to: now, groupBy: 'workspace' })` 各组的 key，去掉空 key。
  - 编辑时沿用原来的 budget id 调 `setBudget`。
  - 新增的文案键（中文，英文另配对应译文）：
    - `settings.budget.empty` = "还没有设置预算。设置后，快超支时会提醒你。"
    - `settings.budget.allWorkspaces` = "全部工作区"
    - `settings.budget.spent` = "已用 {spent} / {limit}"
    - `settings.budget.over` = "已超 {amount}"
    - `settings.budget.duplicate` = "已有相同的预算，请直接编辑"
    - `settings.budget.edit` = "编辑"
    - `settings.budget.invalidAmount` = "请输入大于 0、最多两位小数的金额"
  - 界面开关的说明文字照 spec §4.2 表格，键名用 `settings.element.<name>.hint`。
  - `Section.tsx` 先排预算卡片、再排界面卡片，问题和高级在 Task 4 加。
  - 本任务内要保持 e2e 用到的 `data-tally="budgets"`、`"elements"`、`"settings"` 不变。

- [ ] **Step 4: 运行测试，确认通过**

  Run: `pnpm vitest run packages/tally-ui/tests && pnpm --filter dsh-tally-ui run typecheck`
  Expected: PASS

- [ ] **Step 5: 提交** `feat(tally-ui): budgets and interface cards in dsh settings style`

---

### Task 4: 问题卡片 + 高级分组（价格目录、价格覆盖、重建账本）

**Files:**
- Create: `packages/tally-ui/src/client/settings/problems.ts`（纯函数）
- Create: `packages/tally-ui/src/client/settings/OverrideDialog.tsx`
- Modify: `settings/Problems.tsx`、`settings/CatalogInfo.tsx`、`settings/OverridesEditor.tsx`、`settings/RebuildButton.tsx`、`settings/Section.tsx`、`settings/settings.css`、`locales.ts`
- Test: `packages/tally-ui/tests/problems.test.ts`、`packages/tally-ui/tests/settings.client.test.tsx`

**Interfaces:**
- Consumes: `SettingsCard`、`SettingsRow`（Task 3）；`TallyStatusView.routes`（Task 1）；`CatalogView`
- Produces:
  - `type ProblemRow = { kind: 'sessions'; count: number; items: { sessionId: string; message: string }[] } | { kind: 'usage' | 'pricing' | 'budget'; message: string }`
  - `groupProblems(status: TallyStatusView): ProblemRow[]`：所有会话类错误合并为一个 `sessions` 行，放在最前；其余错误按 usage、pricing、budget 的顺序各自成行

- [ ] **Step 1: 写失败的测试**

  `problems.test.ts`：
  - `six session errors become one row with count 6`
  - `session and budget errors keep separate rows`（对应 Review Focus 4）
  - `no errors give no rows`

  `settings.client.test.tsx` 新增：
  - `problems card is hidden when there are no problems`
  - `session problems show one summary line and expand to the list`：文字"6 个会话的日志无法读取，已跳过"；点击后出现 6 个会话 id
  - `advanced is collapsed by default and shows catalog rows when opened`：展开后能看到"生效于 2026-10-10"和"来源"链接，看不到 `deepseek-flash@2026-10-10`（它只在悬停提示里）
  - `override dialog offers status routes and catalog models`：`status.routes = ['deepseek', 'my-proxy']`；路由下拉里有这两项；选 `my-proxy` 并映射到 `deepseek/deepseek-flash` 后保存，断言写入表单的值
  - `override dialog with no routes disables save and says so`：文字"暂无可选路由"（对应 Review Focus 3）
  - `rebuild row asks for confirmation`（沿用原有用例，改成新的 DOM 结构）

- [ ] **Step 2: 运行测试，确认失败**

  Run: `pnpm vitest run packages/tally-ui/tests/problems.test.ts packages/tally-ui/tests/settings.client.test.tsx`
  Expected: FAIL

- [ ] **Step 3: 实现**

  - 问题卡片：`sessions` 行用 `DisclosureRow` 做成可展开，其余行用警告色；账本可能损坏时的提示保留。
  - 高级分组：外层是 `DisclosureRow`，标题"高级"，`expandable` 为 true，默认收起；里面依次是价格目录卡片、价格覆盖卡片、重建账本行。
  - 价格目录每行左边是模型名，右边是"生效于 {date}"和"来源"链接；价格版本标识放进 `Tooltip`。
  - 价格覆盖列表的每行有"⋯"菜单，菜单里只有"删除"。添加用 `OverrideDialog`：
    - 顶部说明文字照 spec §4.4 原文；
    - 路由下拉的选项来自 `status.routes`；
    - 映射模式下，目标厂商和模型下拉的选项来自 catalog；
    - 自定义价格模式沿用现有的单价校验；
    - 配置不可写时整卡只读并显示原因，行为和现在一致。
  - 重建账本行：左边是说明"从会话日志重新生成账本，账本损坏或数据异常时使用"，右边是按钮，确认框和进度显示的逻辑不变。
  - 新增文案键：
    - `settings.problem.sessions` = "{count} 个会话的日志无法读取，已跳过"
    - `settings.advanced` = "高级"
    - `settings.override.purpose`（spec §4.4 原文）
    - `settings.override.noRoutes` = "暂无可选路由"
    - `settings.effectiveOn` = "生效于 {date}"
    - `settings.rebuild.hint`（上面的说明文字）
  - 删除不再使用的键，并同步更新 `tests/locales.test.ts`。

- [ ] **Step 4: 运行测试，确认通过**

  Run: `pnpm vitest run packages/tally-ui/tests && pnpm --filter dsh-tally-ui run typecheck`
  Expected: PASS

- [ ] **Step 5: 提交** `feat(tally-ui): problems summary and advanced settings group`

---

### Task 5: 费用条、每轮费用、会话累计、预算提醒

**Files:**
- Modify: `CostDock.tsx`、`CostDock.css`、`TurnCost.tsx`、`TurnCost.css`、`SessionTotal.tsx`、`SessionTotal.css`、`BudgetToast.tsx`、`index.ts`、`locales.ts`
- Test: `packages/tally-ui/tests/conversation.client.test.tsx`、`packages/tally-ui/tests/plugin.client.test.ts`

**Interfaces:**
- Consumes: `TallyStore.month`、`TallyStore.budgetSpend`、`pickDockBudget`、`budgetTone`（Task 2）
- Produces:
  - `openDashboard(sessionId?: string): void`：在 `index.ts` 中创建，可选注入 `sidebarRight`。可用时调用 `ctx.sidebarRight.openTab(TAB_KIND, { params: sessionId === undefined ? undefined : { sessionId } })`；不可用时什么也不做。
  - 在 `dashboard/definition.ts` 中声明模块扩充：`interface SidebarRightTabParamsMap { 'tally.dashboard': { sessionId?: string } }`

- [ ] **Step 1: 写失败的测试**（`conversation.client.test.tsx`）

  - `dock shows today, month, budget and band in that order`：断言 `data-tally` 的顺序是 `today`、`month`、`budget`、`band`；不存在 `data-tally="session"`，也不存在 `data-tally="balance"`
  - `dock budget shows the tone and "已超预算" past 100%`：花费 102，限额 100，断言文字"已超预算 ¥2.00"和 `data-tone="over"`
  - `dock without budgets has no budget item`
  - `dock hover card lists session, today, month, budgets and balance when a balance route exists`
  - `clicking the dock opens the dashboard`：断言 `openDashboard` 被调用，且没有参数
  - `unpriced today shows 未定价, never ¥0`（保留原有用例）
  - `session total click opens the dashboard focused on the session`：断言 `openDashboard('s1')`
  - `budget toast reads "今日预算已用 82%（¥8.20 / ¥10.00）" and its 查看 opens the dashboard`
  - `turn cost hover lists input, cache hit, output, hit rate, requests, price version and source`（保留原有用例，改成新的 DOM 结构）

  `plugin.client.test.ts`：
  - `openDashboard is a no-op without sidebarRight`
  - `openDashboard calls openTab with the session id`

- [ ] **Step 2: 运行测试，确认失败**

  Run: `pnpm vitest run packages/tally-ui/tests/conversation.client.test.tsx packages/tally-ui/tests/plugin.client.test.ts`
  Expected: FAIL

- [ ] **Step 3: 实现**

  - **费用条结构**：`<button class="dsh-tally-dock" data-tally="dock">` 包住各项，整条可点击，并且能用键盘聚焦。
  - **费用条各项**：
    - `today`、`month` 显示金额；
    - `budget` 只在有预算时渲染，显示百分比加一条迷你进度条，带 `data-tone` 属性；
    - `band` 前面加一个 `StateDot`：高峰 `warning`，低谷 `done`。
  - **悬停详情**：外层用 `HoverCard`，内容依次是本会话、今日、本月、每条预算、余额（有余额路由时）、当前时段单价，最后是"打开用量看板"。
  - **窄宽度省略**：在 `CostDock.css` 里把费用条设为 `container-type: inline-size`。用 `@container (max-width: …)` 按 band → month → budget 的顺序隐藏，隐藏的那一项前面的分隔点也一起隐藏。断点按实测宽度取值，写成 CSS 自定义属性方便调整。
  - **每轮费用和会话累计**：
    - 改用 `HoverCard` 承载明细，样式和间距按 dsh 规范调整；
    - 会话累计的悬停卡显示按模型拆分的费用和请求次数，数据来自现有 `SessionView.usage`，如果里面没有按模型拆分，就调 `remote.query({ groupBy: 'model', filter: { rootSessionId } })`；
    - 点击会话累计时调用 `openDashboard(sessionId)`。
  - **预算提醒**：文案用 `toast.day` = "今日预算已用 {pct}%（{spent} / {limit}）"、`toast.month` = "本月预算已用 {pct}%（{spent} / {limit}）"，超出时用 `toast.dayOver` 和 `toast.monthOver` = "今日/本月预算已超出（{spent} / {limit}）"。后面加"查看"按钮，点击调用 `openDashboard()`。

- [ ] **Step 4: 运行测试，确认通过**

  Run: `pnpm vitest run packages/tally-ui/tests && pnpm --filter dsh-tally-ui run typecheck && pnpm run build`
  Expected: PASS；`check-client-bundle` 通过

- [ ] **Step 5: 提交** `feat(tally-ui): cost dock, turn cost, session total and toast in dsh style`

---

### Task 6: 右侧栏看板

**Files:**
- Modify: `dashboard/Dashboard.tsx`、`dashboard/Rankings.tsx`、`dashboard/DailyChart.tsx`、`dashboard/HitRateTrend.tsx`、`dashboard/Savings.tsx`、`dashboard/ExportButton.tsx`（改成菜单项）、`dashboard/definition.ts`、`dashboard/dashboard.css`、`locales.ts`
- Test: `packages/tally-ui/tests/dashboard.client.test.tsx`、`packages/tally-ui/tests/chart.test.ts`

**Interfaces:**
- Consumes: `navigation.params?.sessionId`（Task 5 声明）；`TallyStore.today`、`month`、`budgets`、`budgetSpend`（Task 2）
- Produces: `RANGES = ['7d', '30d', 'month']`，默认值为 `'7d'`

- [ ] **Step 1: 写失败的测试**（`dashboard.client.test.tsx`）

  - `header offers 7d / 30d / month and an export item in the ⋯ menu`
  - `overview shows today and month side by side and one progress row per budget`
  - `unpriced requests appear as one muted line, not a warning block`：文字"12 次请求未定价"
  - `rankings switch between session, model and workspace and show the top 10`：给 12 个会话，断言只有 10 行，以及存在"显示全部"
  - `deleted sessions carry a 已删除 tag`
  - `opening with a sessionId selects the session ranking and highlights it, expanding past the top 10 if needed`（对应 Review Focus 5）
  - `cache and peak card is collapsed by default`
  - `loading shows placeholders without loading text; empty shows the empty sentence; error shows 重试`

  在 `chart.test.ts` 中把 `rangeBounds` 的用例改成三个范围。

- [ ] **Step 2: 运行测试，确认失败**

  Run: `pnpm vitest run packages/tally-ui/tests/dashboard.client.test.tsx packages/tally-ui/tests/chart.test.ts`
  Expected: FAIL

- [ ] **Step 3: 实现**

  - 结构照 spec §6，每张卡片用 `.dsh-tally-card`。
  - 每日费用的悬停用 `Tooltip`。
  - 排行切换用 `SegmentedControl`；已删除标记用 `Tag`。
  - 缓存与峰谷卡片用 `DisclosureRow`。
  - 加载中的占位块用 `.dsh-tally-skeleton`，底色用 `--dsw-alias-bg-layer-2` 一类语义 token，在减少动态效果模式下不做闪烁动画。
  - 新增文案键：
    - `tab.overview.today`、`tab.overview.month`
    - `tab.unpricedLine` = "{count} 次请求未定价"
    - `tab.showAll` = "显示全部"
    - `tab.empty` = "还没有用量记录，开始一次对话后这里会显示费用"
    - `tab.analysis` = "缓存与峰谷"
    - `tab.savingsLine` = "本期因低谷时段节省约 {amount}"

- [ ] **Step 4: 运行测试，确认通过**

  Run: `pnpm vitest run packages/tally-ui/tests && pnpm --filter dsh-tally-ui run typecheck`
  Expected: PASS

- [ ] **Step 5: 提交** `feat(tally-ui): dashboard cards in dsh style`

---

### Task 7: 端到端测试、截图、文档

**Files:**
- Modify: `packages/tally-ui/tests/e2e/web.e2e.test.ts`
- Modify: `packages/tally-ui/README.md`、`docs/superpowers/specs/2026-10-10-dsh-tally-design.md`（在 §5.6 开头注明"已由 2026-10-12 的重设计文档取代"）
- Create: `docs/superpowers/plans/2026-10-12-dsh-tally-ui-redesign-execution-notes.md`（记录执行中的 Ruling）

- [ ] **Step 1: 更新原有 e2e 用例**
  - 余额检查改为悬停费用条后在详情卡里查找 `data-tally="balance"`；
  - 原来的 `dockItem('session')` 改为检查会话标题栏的 `data-tally="total"`；
  - 其余用例按新的 DOM 结构更新定位。

- [ ] **Step 2: 新增 e2e 用例**
  - `adds a budget through the dialog and sees it on the dock`
  - `opens advanced settings and sees the catalog`
  - `dock drops band, then month, then budget as the composer narrows`：视口依次设为 1280、900、700、560，各断言可见的项
  - `merges unreadable sessions into one problem line`：先尝试在测试的 `DSH_HOME` 里放 2 个无法解析的会话日志（例如截断的 `session.jsonl.zstd`）来触发跳过；如果这样触发不了，就删除这个 e2e 用例，依靠 Task 4 的单元测试，并在 execution notes 里记一条 Ruling

- [ ] **Step 3: 截图**

  设置页（展开高级之后）、看板、费用条各截一张浅色和一张深色主题的图，深色用 `page.emulateMedia({ colorScheme: 'dark' })`，保存为 `tests/e2e/screenshots/{settings,dashboard,dock}-{light,dark}.png`。

- [ ] **Step 4: 运行全部验证**

  Run: `pnpm test && pnpm typecheck && pnpm test:e2e`
  Expected: 全部 PASS

  然后用独立安装的 dsh alpha 再跑一遍 web e2e：

  Run: `DSH_E2E_BIN=<alpha 的 dsh bin> pnpm vitest run --config vitest.e2e.config.ts packages/tally-ui`
  Expected: PASS

- [ ] **Step 5: 更新文档并提交** `test(tally-ui): e2e and screenshots for the redesign; docs`

  `packages/tally-ui/README.md` 的"功能"一节按新结构改写：费用条的各项、设置页的卡片顺序、高级分组。
