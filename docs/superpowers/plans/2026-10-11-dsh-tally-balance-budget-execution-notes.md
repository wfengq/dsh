# dsh-tally 余额与预算（计划 2）执行记录

> 执行方式：逐任务子代理实现加独立审查；最后做全分支审查并统一修复。下面的条目原样摘自执行台账（英文）。

## 执行中做出的裁决（Rulings）

- Ruling 1: budget threshold comparison is exact BigInt on 18-dp Fixed units: spent*10 >= limit*8 for 0.8, spent >= limit for 1 — no floats per Global Constraints — cost if wrong: none
- Ruling 2: Task 5 dependency names are taken from the official packages' package.json name field (expected @deepseek-ai/dsh-credentials and @deepseek-ai/dsh-deepseek-account) and verified on npm before use — cost if wrong: install failure caught immediately
- Ruling 3: accept implementer's 63s timing (brief's "60s" example contradicted its own rule; the rule wins) — cost if wrong: none
- Ruling 4: the auto-refresh debounce must have a max wait — a burst of entries <3s apart may not postpone the refresh more than minIntervalMs after the first pending trigger (during a long agent run the balance must still update) — enters Task 1 fix loop — cost if wrong: a few more balance requests during bursts (still ≤ 1 per minIntervalMs)
- Ruling 5: Task 3 must validate before BudgetFile.put (put stores invalid budgets and the next load would quarantine the whole file) — carried into Task 3 dispatch: TallyBudget.set validates first; additionally BudgetFile.put throws on invalid input (defence in depth) — cost if wrong: none
- Ruling 6: fix round also covers reviewer Minor 1 (alert/markFired for a budget removed or replaced during the awaited query → re-read and confirm budget after await) and Minor 2 (an entry from an earlier period overwrites the current period's fired record → later entry re-alerts, violating the once-per-period Global Constraint; ignore evaluations whose period start is older than the recorded one) — cost if wrong: small widening
- Ruling 2 verified: npm has @deepseek-ai/dsh-credentials@0.2.0-rc.2 and @deepseek-ai/dsh-deepseek-account@0.2.0-rc.2 (names as expected)
- Ruling 7: accountFetcher's client `version` = module constant '0.2.0-rc.2' (the plan leaves the source unspecified; the official settings-account UI also hardcodes its dsh version in accountClientMetadata) — cost if wrong: platform sees an old client version after a dsh upgrade; one-line change
- Ruling 8: Task 4 minor 3 (parseAccountBalance currency filter) is moot — AccountWallet.currency is typed 'CNY' | 'USD' in dsh-deepseek-account — cost if wrong: none
- Ruling 9: fix round 1 = type-only CredentialRef import + cast; also take cheap minors: abort path throws signal.reason; build URL outside try so an invalid baseURL gets its own message; cancel non-2xx body; README wording for baseURL path + headers; test that disposing the plugin unregisters both routes — deferred: resolveKey errors unwrapped (provider text, no key), officialRoute===accountRoute collision, tests outside tsc include — cost if wrong: small widening
- Ruling 10: accept the implementer's scanner-driven renames (tally private `fetch` → `runFetcher` to drop a false `network` flag; balance-deepseek local `doFetch` → `fetch` so the real creds+network capability is disclosed) — the trust gate is meant to reflect real capabilities, and both edits are behaviour-neutral — cost if wrong: none (names only); scanner heuristics may shift in later trust-check versions
- Ruling 11: final fix wave covers Important 1 (budgetPath in test harness + vitest globalSetup pointing DSH_HOME at a temp dir for unit/e2e/perf configs), Minor 1 (integration test: real usage + budget alert fires on live entries, none on backfill/rebuild), Minor 3 (coalesce queued same-budget evaluations to the latest), Minor 4 (add status() to BudgetService in dsh-tally-api — additive, plan 3 UI needs it), Minor 5 (message names the configured ref) — deferred to plan 3: cross-process budget file locking (document single-process now; plan 3 adds the editor and should use @deepseek-ai/dsh-atomic-write withFileLock), get() retry for never-succeeded snapshot, structured error code for "not configured", lockfile web-profile check — cost if wrong: multi-process users can lose a budget edit until plan 3
- Ruling 12: controller applied two residual minors directly (f7d0af9): periods evaluated oldest-first; per-period try/catch so one failure doesn't cost the batch — both with tests proven red without the fix; full test/typecheck/e2e/perf green — deferred: budget selection replaced mid-batch is evaluated on the next live entry — cost if wrong: none

## 全分支终审

- Final review (opus, 7a5f774..d484965): With fixes — Important: unit tests mount full plugin with default budgetPath → write the developer's real $DSH_HOME/tally/budgets.json (verified); Minors: no TallyBudget×real TallyUsage test; budget file not cross-process safe; per-entry full-period queries ~0.3s each at 100k rows; README documents status() missing from dsh-tally-api BudgetService; 'DEEPSEEK_API_KEY not configured' ignores apiKeyRef; get() never retries a never-succeeded snapshot; lockfile dropped optional peer resolutions
- Final fix wave: 8d857c3 — re-review (opus): all 6 addressed, no new Critical/Important; 3 Minor coalescing regressions
- Final review: complete (plan 2 range 7a5f774..f7d0af9)

## 暂缓处理的小问题（留给后续计划）

- Task 1: minor (deferred): register after service dispose succeeds but always stale; refresh on route disposed mid-flight returns stale not null; timeout test weak; misnamed test; no dispose+re-register-in-flight test
- Task 1: minor (deferred): manual refresh doesn't cancel a pending auto timer (one extra request possible)
- Task 2: minor (deferred): put/markFired mutate memory before save (diverge if write throws); quarantine name collision within same ms; validateBudget lenient on extra fields; non-ENOENT read errors throw
- Task 3: minor (deferred): dispose under-tested; await chain can hang on stuck query; partial history during backfill (late alerts); invalid timeZone not validated at apply; same-id replacement keeps fired marks (undocumented); full-period query per entry per budget (resolved later by coalescing, 8d857c3)
- Task 4: minor (deferred): exponent cap |1000| undocumented/untested; corner cases (007.50, 12.345e±1, -0.000) only hand-traced; parseAccountBalance doesn't filter non-CNY/USD and throws RangeError not shape error (carried to Task 5); redundant cast parse.ts:211
- Task 5: minor (deferred): resolveKey errors unwrapped (provider text); officialRoute===accountRoute collision unvalidated; test files outside package tsc include; baseURL userinfo not rejected
- Task 6: minor (deferred): probe null snapshot gives unclear failure message; trust test core checks would pass if lib missing (pretest guards)
- Final review (deferred to plan 3): cross-process locking of budgets.json (use @deepseek-ai/dsh-atomic-write withFileLock with the budget editor); tallyBalance.get() never retries a never-succeeded snapshot; structured error code for "not configured"; check a fresh --frozen-lockfile install with --profile web (lockfile dropped optional peer resolutions); budget selection replaced mid-batch is only evaluated on the next live entry
