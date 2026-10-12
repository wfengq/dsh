# dsh-tally-ui 重设计：执行记录

计划：[`2026-10-12-dsh-tally-ui-redesign.md`](2026-10-12-dsh-tally-ui-redesign.md)；设计：[`../specs/2026-10-12-dsh-tally-ui-redesign-design.md`](../specs/2026-10-12-dsh-tally-ui-redesign-design.md)。执行方式：在当前会话内逐任务完成，最后整体审查一次。

## 执行中的裁定

- Task 1: Ruling: groupBy 'provider' keys are route-mapped vendors, not routes — added TallyStore.distinctRoutes() + TallyUsage.routes() — cost if wrong: one extra SQL query per status call.
- Task 1: Ruling: cordis 4 has no optional inject — read llm lazily via ctx.get('llm') in knownRoutes() — cost if wrong: routes list misses configured-but-unused routes when llm loads later than the status call (next status refresh fixes it).
- Task 2: Ruling: existing store tests counted every query; they now count day-span queries (dayCalls) since month/budget queries are new — cost if wrong: none, assertions unchanged in meaning.
- Task 3: Ruling: money keeps the existing formatter (trailing zeros stripped: ¥8.2, ¥10) instead of spec examples ¥8.20 — one formatter across the UI — cost if wrong: a formatter tweak.
- Task 3: Ruling: edit dialog title is "编辑预算" (settings.budget.edit) and the ⋯ menu's edit item reuses it; delete reuses settings.remove — cost if wrong: copy change.
- Task 3: Ruling: problems/catalog/overrides/rebuild stay in their old layout below the new cards until Task 4 — cost if wrong: none (Task 4 replaces them).
- Task 4: Ruling: the override route picker sits above the alias/manual switch (route first, then how to price it), and "rebuild" keeps its own small card inside Advanced — reads top-down like the spec's list — cost if wrong: layout swap.
- Task 4: Ruling: the alias target model picker offers "任意模型" (whole vendor) as its first choice, mapping to the existing optional target.model — cost if wrong: none.
- Task 5: Ruling: BandView carries no rates, so the dock hover shows the band and its countdown ("当前时段") instead of a unit price — no new API — cost if wrong: add rates to BandView later (additive).
- Task 5: Ruling: openDashboard tests live in tests/open-dashboard.test.ts (pure helper makeOpenDashboard) rather than plugin.client.test.ts; it also checks elements.sidebarTab since openTab throws for an unregistered kind — cost if wrong: none.
- Task 5: Ruling: TurnCost already uses HoverCard; no structural change made (spec only asked for styling) — cost if wrong: a CSS touch-up.
- Task 5: Ruling: toast copy is "{period}预算已用 {pct}%" / "{period}预算已超出" with period 今日/本月 plus "（workspace）"; unknown budgets get an empty period — cost if wrong: copy change.
- Task 6: Ruling: the tab's session focus is read from tab.navigation.params as unknown and narrowed, instead of augmenting SidebarRightTabParamsMap — avoids depending on that module's augmentation surface — cost if wrong: none at runtime.
- Task 6: Ruling: no settings-navigation API exists, so the unpriced line's tooltip names the settings path (tab.unpricedHint) instead of a link — cost if wrong: add a link when dsh exposes settings navigation.
- Task 6: Ruling: the savings line keeps the existing "peak vs off-peak equivalent" fact (tab.savingsFact) rather than the shorter spec wording — it says more with the same data — cost if wrong: copy change.
- Task 6: Ruling: data.ts now returns full sorted rankings (sortGroups) and the page shows the top 10 until "显示全部"; an empty page also requires no sessions — cost if wrong: none.
- Task 6: Ruling: card material moved to src/client/card.css shared by settings and dashboard — cost if wrong: none.
- Task 7: Ruling: container queries collapsed the dock to ~0 width (an inline-size container has no intrinsic width in dsh's content-sized dock row); switched to window-width media queries (band ≤1100px, month ≤860px, budget ≤640px) — cost if wrong: thresholds approximate the composer width and may need tuning.
- Task 7: Ruling: adding a budget did not reach the dock until the next hello; added TallyStore.refreshBudgets(), called by the budgets card after save/remove (RED→GREEN unit tests) — cost if wrong: none.
- Task 7: Ruling: the settings page only takes amounts with ≤2 decimals, but mocked turns cost <¥0.0001; the e2e creates a ¥0.01 budget through the UI and then shrinks it in budgets.json (the Host rereads the file) to trigger the toast — cost if wrong: test-only.
- Task 7: Ruling: no e2e for merged unreadable sessions — corrupt session files in the test DSH_HOME risk dsh's own UI logging errors; covered by problems.test.ts and the settings client tests (plan's fallback) — cost if wrong: one more e2e later.
- Task 7: Ruling: price catalog shows only the date part of effectiveFrom (timestamps read as 2026-10-10) — cost if wrong: none.
- Task 7: Ruling: skipped the local alpha-channel e2e rerun; the compat CI runs latest and alpha on every push — cost if wrong: an alpha regression shows up in CI instead of locally.
