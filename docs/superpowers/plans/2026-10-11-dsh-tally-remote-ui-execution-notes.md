# dsh-tally Remote API 与参考界面（计划 3）执行记录

> 执行方式：逐任务子代理实现加独立审查；最后做全分支审查并统一修复。下面的条目原样摘自执行台账（英文）。

## 预检

| Rows | Produces vs consumes / self-consistency | Finding |
|---|---|---|
| T1↔T2 | contract.ts/service.ts: T1 descriptor shape + schemas.<m>.{request,result}; T2 extends same pattern | consistent |
| T2↔T3 | same files; T3 adds stream descriptor + TallyWatchFrame | consistent |
| T1↔T5 | tally-ui/src/index.ts: T1 empty apply; T5 adds volatile Config.elements | consistent |
| T4↔T7 | BalanceSnapshot.errorCode consumed by BalanceText | consistent |
| T5↔T7/T9 | configForms('tally-ui').elements.*, configForms('tally').overrides; entry ids from T1 | consistent |
| T2↔T7 | band/turn; TurnLocation.start/end may be undefined | T7 must return null when start/end missing (turnTail renders completed turns only) — Ruling 3 |
| T3↔T6↔T9 | `status` frames drive RebuildButton; T6 text lists hello/recorded/balance/budget handling but not `status` frames | gap — Ruling 1 |
| T6↔T7/T8/T9 | T6 "writes all copy at once"; later tasks may need extra keys | Ruling 2 |
| T1↔T7↔T10 | T1 e2e asserts [data-tally="status"]; T7 deletes StatusDot; T10 rewrites e2e later | conflict: e2e red between T7 and T10 — Ruling 4 |
| T2↔T5 | both modify store.ts sequentially | consistent |
| T5↔T8 | UsageGroup.deletedCount → tab.deleted mark | consistent |
| T1 self | interface adds TallyBalance.routes() but Files omits balance-service.ts | Ruling 5 (allowed) |
| T2 self | catalog/setBudget touch pricing-service/budget-service not in Files | Ruling 5 |
| T3 self | tests match interface | consistent |
| T4 self | tests match interface; README note removal | consistent |
| T5 self | volatile-update test method left to installed .d.ts | acceptable (implementer verifies) |
| T6 self | TestRemote + manual async queue for watch | consistent |
| T7 self | SlotTestRuntime plugin test; files list ok | consistent (+Ruling 4) |
| T8 self | chart.ts used but not in Files list | Ruling 5: packages/tally-ui/src/client/dashboard/chart.ts |
| T9 self | configForms fake needs getSnapshot/subscribe/set | consistent |
| T10 self | balance-deepseek install + overlay baseURL | consistent |
| Global vs tasks | float ban vs hitRate/chart pixels — both explicitly exempted | consistent |
| Rubric | no plan-mandated vacuous tests or duplicated logic found | clean |

Ruling 1: T6 store also updates the `status` snapshot on every `status` frame (and on `hello`) — T9 RebuildButton depends on it — cost if wrong: none
Ruling 2: T7–T9 may add dictionary keys beyond T6's list, always to both zh and en (locales parity test stays) — cost if wrong: none
Ruling 3: TurnCost returns null when turn.start or turn.end is undefined — cost if wrong: an open turn shows no cost until it closes (spec says turnTail is per completed turn)
Ruling 4: T7 updates packages/tally-ui/tests/e2e/web.e2e.test.ts to assert the SessionTotal element ([data-tally="total"]) instead of the removed StatusDot, keeping test:e2e green — cost if wrong: none
Ruling 5: files named in a task's Interfaces but missing from its Files list (T1 balance-service.ts, T2 pricing-service.ts/budget-service.ts, T8 dashboard/chart.ts) are in scope for that task — cost if wrong: none


## 执行中做出的裁决（Rulings）

- Ruling 6: fix round 1 also takes Minor 1 (silence tsdown legacy-CJS warning via checks.legacyCjs:false — pristine output) and Minor 4 (drop redundant ctx.effect around $mount; $mount registers its own effect and the extra one throws INACTIVE_EFFECT if disposed mid-mount) — cost if wrong: none
- Ruling 7: accept Remote status/hello reporting backfill:null when idle (TallyUsage.status() keeps last progress for existing callers) — the brief requires a final null frame and UI needs "idle" — cost if wrong: Remote status differs from raw service status (documented in T10 README)
- Ruling 8: accept additive RemoteError 'tally/write-failed' (setBudget/removeBudget await the queued write so the UI can show real failures) and TallyBudget.flush() (not on public API) — cost if wrong: one extra error code in the contract
- Ruling 9: fix round 1 also takes Minors 3 (quarantine only under lock; read path reports + keeps state), 4 (markFired skips ids absent from disk budgets), 5 (memory-on-failure test must fail at write, e.g. mocked writeFileAtomic), 6 (README codes wording) — all touch the same code and protect RF3 — cost if wrong: small widening
- Ruling 10: accept additive CatalogView.overrides? (catalog reflects override config without inventing providers), watch hello on override change, isVolatile from cosmokit (brief said schemastery) — cost if wrong: one optional field in the contract
- Ruling 11: @deepseek-ai/dsh-client-test-runtime@0.2.0-rc.2 is unusable outside the dsh repo (imports unshipped src, needs vitest 4) — Tasks 6–9 use hand-rolled fakes instead of TestRemote/SlotTestRuntime (scripted remote object; for plugin-level slot tests a minimal fake ctx with slots/locale/remote/configForms recording registrations) — cost if wrong: fakes may drift from real dsh behaviour; Task 10's real-web e2e is the backstop
- Ruling 12: accept plain .css with dsh-tally-* class names (Task 1 bundler injects global CSS; brief's .module.css not supported by it) and stubbed ui-primitives in jsdom tests (real bundle doesn't load under vitest; real-web e2e is the backstop) — cost if wrong: class-name collisions (prefixed) / stub drift caught by e2e
- Ruling 13: accept unpriced entry as hint text (no reachable settings-navigation service from a tab body in installed types) and four day queries (peak/offpeak/flat + unfiltered for tokens & unpricedCount) — cost if wrong: one extra click for the user; 2 extra queries per range change
- Ruling 14: fix round 1 also pins TZ in dashboard tests (Minor 1: DST-sensitive span assertions → flaky by machine zone) — cost if wrong: none
- Ruling 15: fix round 1 also takes Minor 1 (neutral read-only reason for element switches) and Minor 3 (keep rebuild button disabled until the first status frame after a successful call) — cost if wrong: none
- Ruling 16: one fix wave = Important 1–6 + fix-before-merge minors (README third-party example as detached loop with tolerant mount; timestamp bounds ±8.64e15 int → bad-request) + cheap minors (budget ids colliding with Object.prototype; balance routes from status frames; dashboard refresh on hello generation/recorded; schema description "上方"→"下方"; not-configured copy points to settings; TurnCost label vs number for retries; peer dep dsh-tally-ui→dsh-tally; deferred revokeObjectURL; clear loadError on successful reload/write; turnTail e2e positive poll) — deferred: strict codec forward-compat (document in README as breaking-for-old-bundles), plus the "fine to keep deferred" list — cost if wrong: larger fix wave
- Ruling 17: residual item 1 is load-bearing (documented third-party path breaks the reference UI) and the fix is small and exactly specified — resume the fixer for this single item with a scoped re-review, rather than parking it for merge (a deliberate exception to "no second fix wave") — cost if wrong: one extra small round

## 全分支终审

- Final review (opus, 3a9118b..85299fc): With fixes — Important: (1) second $mount of TALLY_REMOTE throws "already registered" → README-style third-party plugin + dsh-tally-ui conflict; (2) TurnCost never refetches after override edit/hello; (3) §6 errors (usage.errors, pricingErrors, budgetErrors) not shown in settings; (4) "today" stale after midnight; (5) budget toast/list named by UUID; (6) dashboard shows no spent amounts
- Final fix wave: ecf8bc6..146dbb7 — re-review (opus): 11 addressed; item 1 OPEN (Important): tolerant mount matches registry text, but the real gateway client throws "client api: direct method <endpoint> is already mounted" from validateContribution first → second mount still fails on a real host; READMEs/tests repeat the wrong message
- Final review residual minors (deferred): Problems list refreshes only on hello/status frames (cleared budget error may linger); result timestamps unbounded; identical budget names possible; namespace lifetime tied to first mounter (documented)
- Final fix residual: 03afe7c — re-review: ADDRESSED, no new Critical/Important
- Final review: complete (plan 3 range 3a9118b..03afe7c); controller verification: pnpm test 529, typecheck, test:e2e 10, test:perf 2 all green

## 暂缓处理的小问题（留给后续计划）

- Task 1: minor (deferred): bundle check has no automated negative test; regex misses __require; SHARED_MODULES duplicated in tsdown config and check script; fixed-string banner wrong for future non-entry chunks; status() casts injected services to concrete classes; dsh-tally-ui lacks peer dep on dsh-tally
- Task 2: minor (deferred): timestamps beyond Date range (e.g. 1e16) pass zod and throw RangeError inside Intl → internal error instead of bad-request; nullable results use named typeSymbol; until not clamped to effectiveTo; CSV formula-injection unguarded; CSV tie-break compares ids as text; test polish (duplicate turn call); query band filter ignores usageKnown (pre-existing); savings/csv O(n) quoting
- Task 3: minor (deferred): stale frames after overflow hello (UI must treat recorded idempotently / refetch); no test for observer/timer cleanup on abort; listener count reads cordis internal _hooks; doc comment on lazy hello
- Task 3: minor (deferred): watch() called after dispose adds an unclosed state; test reads private state.observers
- Task 4: minor (deferred): flush() waits on evaluation chain (Remote latency); loadError never cleared
- Task 4: minor (deferred): README "next write" vs any locked op quarantines; failed edit visible in list() for a microtask; edit wraps sync throws as write-failed; fallback set/remove can't report failure for third-party tallyBudget; loadError never cleared
- Task 5: minor (deferred): live-then-gone race flags deleted until next scan (add code comment); failed reload keeps old pricing silently; deletedCount is 0 not absent for non-deleted; TallyPricing.overrides() returns internal array; no reconciliation test through rebuild/aborted backfill
- Task 6: minor (deferred; 1 and 3 carried into Task 7 dispatch): (1) fire-and-forget loads can raise unhandled rejections on transport rejection; (2) today/session failures invisible (no error channel); (3) session cache never released (refcount); (4) hello balance loads not sequence-guarded; (5) abort only when iterable yields; (6) coverage gaps (0.99995, tiny negative, DST today window, 5 s ceiling); (7) tests not type-checked
- Task 7: minor (deferred): balance with no total wallet & no error shows "查询失败：" (should be — or sum); empty turns re-query on every today change; TurnCost stops at first non-empty answer; BalanceText 10s timer not cleared on unmount; a11y (HoverCard keyboard, SessionTotal aria-label); toast no explicit close action; coverage gaps (route priority fixtures, signed-out/failed copy, elementsOf); raw ids shown in subagent rows/toast; duplicated .dsh-tally-num
- Task 8: minor (deferred): chart.ts/decimal.ts without recorded RED; CNY-first ranking for mixed currencies; single-point circle distorted by preserveAspectRatio=none; hard-coded font sizes; peakSavings has no tz
- Task 9: minor (deferred): confirm footer styling may not apply when portaled; coverage gaps (manual cache rates round-trip, alias w/o model, rebuild failure, switch write failure, budget list refresh, parity both directions); budget amount no fraction cap (server validates); same-route override replaced silently
- Task 10: minor (deferred): turnTail-off check fixed 3 s wait (add poll for count 0 after toggle); README third-party example's for-await inside ctx.inject callback never resolves (should be detached loop + abort); trust bundle check indirect; budget UUID in toasts/list; README balance row wording unverified
