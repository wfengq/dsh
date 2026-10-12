# dsh-tally 核心（计划 1）执行记录

> 执行方式：逐任务子代理实现加独立审查；最后做全分支审查并统一修复。下面的条目原样摘自执行台账（英文）。

## 执行中做出的裁决（Rulings）

- Ruling 1: holidayCalendarMissing is set only when the date's ISO weekday is in `windows.days` (a holiday could only change the result on those days); weekends never carry the flag — spec says "那一年工作日的报价会标记" — cost if wrong: an extra/missing advisory flag on weekend quotes, no amount change.
- Ruling 2: Task 8's live-emit test uses fixtures at T0 (Wed 2026-10-14 10:00 +08:00, peak) with U1 (input 100, cacheRead 900, cacheWrite 0, output 50) on deepseek-official/deepseek-flash; expected cost.amount = '0.000636' — cost if wrong: test value mismatch, caught immediately.
- Ruling 3: Task 9 may modify packages/tally/src/index.ts and usage-service.ts if needed so backfill drains its current batch before host dispose — plan text in Task 9 already mandates the behaviour, only its Files list omits the file — cost if wrong: small scope widening of Task 9.
- Ruling 4: replace plan's "packageManager": "pnpm@10" with the exact installed pnpm version (full semver) — plan value was shorthand; pristine output is required — cost if wrong: none (pins a pnpm version)
- Ruling 5 (supersedes Ruling 1): holidayCalendarMissing is set only when the resolved band is 'peak' (a missing holiday can only turn peak into offpeak, i.e. the warning is "may be overestimated"; on offpeak/weekend it is meaningless noise) — implementer concern 2 confirmed as real gap; fix in band.ts + tests — cost if wrong: warning shown less often (never on offpeak)
- Ruling 6: quote() returns null for any version carrying `tiers` until tier semantics are specified (no tiered data exists; avoids under-pricing) — cost if wrong: tiered providers show "unpriced" until implemented
- Ruling 7: fresh-clone ordering (type tests resolve dsh-pricing-data via gitignored lib/) — Task 9 adds root "pretest" and "pretypecheck" scripts running `pnpm -r run build` — cost if wrong: slower test runs
- Ruling 8: tighten ProviderPriceOverride manual.models value type from `PriceVersion['rates']['flat']` (Rates|undefined) to `Rates` before first release — carried into Task 7 (first consumer) — cost if wrong: none pre-1.0
- Ruling 9: attempts settled with no usage sample (e.g. failed 429 requests) are kept as ledger entries with usageKnown:false — a request was made and the provider may bill partial streams; they count toward unknownUsageCount, never cost — cost if wrong: inflated 'usage unknown' counts for failed requests
- Ruling 10: fix round also covers reviewer Minor 3 (INSERT OR IGNORE swallows NOT NULL/CHECK violations as "duplicate" → use ON CONFLICT(id) DO NOTHING) and Minor 2 (constructor-time corruption bypasses quarantine and leaks the handle) — both are swallowed-error/leak class the rubric rates Important; cheap to fix now while the store is fresh — cost if wrong: one extra small fix round
- Ruling 11: an invalid user override (bad manual rate) must not stop the pricing service — Task 8 wires TallyPricing so invalid overrides are skipped, logged via ctx.logger, and listed in status().errors; that route then stays unpriced — cost if wrong: a mistyped override silently ignored (but visible in status)
- Ruling 12: fix (1) by stripping the synthetic closer suffix for non-live records before ingest (recompute with dsh-session's exported interruptedTurnClosers and compare); no billing is lost because the fold never bills a sample-less step/end — cost if wrong: crashed turns stay "open" in the cursor until more events arrive
- Ruling 13: fix (2): persist a backfill-complete marker; after the first full backfill, later starts only read sessions with no cursor or whose saved fold state is mid-turn; completed sessions are skipped (a session resumed later in another process is caught when that process records it itself or on rebuild); yield to the event loop between sessions — cost if wrong: an old session resumed only in a tally-less process is under-counted until rebuild
- Ruling 14: also in this round (cheap, prevents permanent/visible errors): root lookup falls back to ctx.sessions.get(id)?.header; 'tally/recorded' is emitted only for live-path entries (not backfill/rebuild) per spec "每次模型请求结算后推送"; fix README backfill timing + wrong disposal-order comment; enable WAL + synchronous=NORMAL — cost if wrong: small scope widening
- Ruling 15: accept implementer choices in Task 8 fix round 1 — strip closers on every read (exact-match only), re-read sessions with open turn even if fold idle, sidecar test checks no stale content — cost if wrong: slightly more re-reads
- Ruling 16: 100k perf test ran at 942ms in a parallel full run (flake risk) — Task 9 excludes `**/*.perf.test.ts` from the default `pnpm test` and adds a `test:perf` script that runs it alone — cost if wrong: perf regressions only caught when test:perf is run
- Ruling 17: fix round also adds `"pretest:e2e": "pnpm -r run build"` (reviewer Minor 1) and uses the plugin's exported default providerRoutes in the e2e consistency check if exported, else leave (Minor 2) — cost if wrong: none
- Ruling 18: final fix wave = Important 1–3 + README must-fix line + cheap money-relevant minors: reject reasoningBilledAs 'separate' in validator (double count), validate alias-override targets into status().errors, band/priceVersion null when usage unknown, fix vitest warning comment; LICENSE files — cost if wrong: small widening of the fix wave
- Ruling 19: final-review "Declined to judge" items accepted as out of scope for plan 1 (side LLM calls not in session log → M5 reconciliation; holidayCalendarMissing on entries → plan 3; markSessionDeleted → plan 3; holidays empty until State Council notice; pre-2026-10-10 unpriced per spec) — cost if wrong: these surface in later plans

## 暂缓处理的小问题（留给后续计划）

- Task 1: minor (deferred): formatFixed mishandles negative Fixed (unreachable via public API)
- Task 1: minor (deferred): costOf floors silently for hand-built Fixed with >12dp; doc precondition
- Task 1: minor (deferred): test gaps — costOf RangeError branch, "", "1.", ".5", 12-dp boundary, >2^53 products
- Task 1: minor (deferred): .gitignore ignores .superpowers/ (intended: SDD scratch is not committed)
- Task 1: minor (deferred): package tsconfig includes only src; tests/ never type-checked by tsc
- Task 1: minor (deferred): pnpm ignored esbuild build script; no onlyBuiltDependencies set
- Task 2: minor (deferred): tz-crossing test non-discriminating; add 2026-10-11T01:00Z (Sun UTC / Mon 09:00 Shanghai → peak); misleading comment band.test.ts:221
- Task 2: minor (deferred): no DST-zone / hour-24 normalisation test
- Task 2: minor (deferred): parseRange lazy inside .some(); accepts 25:99; reparsed per call
- Task 2: minor (deferred): holidays[id] lookup not Object.hasOwn-guarded ('constructor')
- Task 2: minor (deferred): unused _omit var in band.test.ts:212
- Task 3: minor (deferred): misleading test name quote.test.ts:612 (will change with Ruling 5 fix anyway)
- Task 3: minor (deferred): validator negative tests only assert length>0; grouped scenarios in one it
- Task 3: minor (deferred): validator gaps — windows vs rates band cross-check, 24:30 accepted, holiday date calendar validity, generatedAt/retrievedAt format
- Task 3: minor (deferred): quote() throws RangeError on malformed token counts; undocumented
- Task 3: minor (deferred): validator does not require peak+offpeak rates when windows set (quote returns null)
- Task 4: minor (deferred): re-exports Quote/PriceVersion widen frozen contract, couple semver to dsh-pricing-data; TallyBand duplicates Band without assertion
- Task 4: minor (deferred): type tests don't cover built lib/index.d.ts; gaps (SessionUsage.children, alias override, Budget/BudgetAlert, TallyStatus, workspaceId optional)
- Task 4: minor (deferred): typecheck.enabled globally — every vitest run pays tsc pass
- Task 5: minor (deferred, money-relevant for non-DeepSeek vendors): normalizeUsage known:true with totalTokens but missing cache bucket leaves an unpriced prompt-token gap; consider gap>0 → known:false (unreachable with current official adapters)
- Task 5: minor (deferred): open.sample always null → dead fallbacks/step-end billing branch kept for parity
- Task 5: minor (deferred): packages/tally tests not type-checked (tsconfig includes src only)
- Task 5: minor (deferred): equivalence test narrow; no cacheWrite/totalTokens comparison
- Task 5: minor (deferred): pnpm esbuild build-script approval warning on install
- Task 6: minor (deferred): sessionIds IN-list could exceed bound-variable limit; quarantine rename race across processes; no -wal sidecar move test
- Task 6: minor (deferred): transaction() sync-only (Promise-returning fn commits early) — document; COMMIT+ROLLBACK double failure desyncs #inTransaction
- Task 6: minor (deferred): completeness check only checks table names, not columns
- Task 7: minor (deferred): manual overrides never bill reasoning tokens (silent under-price vs null)
- Task 7: minor (deferred → decide in Task 8): bad manual rate throws RangeError in TallyPricing constructor, stopping the service
- Task 7: minor (deferred): cached path skips costOf token validation (defensive only)
- Task 7: minor (deferred): unknown-usage tokens counted in group token totals
- Task 7: minor (deferred): query.ts amountUnits/formatUnits duplicate formatFixed logic
- Task 7: minor (deferred): bucketStableZones collects tz from all versions (conservative)
- Task 8: minor (deferred): readSession has no AbortSignal (dispose latency); ownEvents() deprecated (plan-mandated); status()/query() throw with foreign tallyPricing impl
- Task 8: minor (deferred): after rebuild/first install, a live event on an open session before backfill reaches it refolds ownEvents() with notify:true → history emitted as tally/recorded
- Task 8: minor (deferred): sessions with no own events / abandoned mid-turn are re-read every start (perf only)
- Task 8: minor (deferred): README limitation omits "session continued here while plugin disabled"
- Task 8: minor (deferred): WAL unsuitable for network filesystems dbPath
- Task 9: minor (deferred): second e2e test depends on firstIds from the first; e2e file not covered by tsconfig; lockfile churn (cordis peer-suffixed variant); node:sqlite ExperimentalWarning visible to users in host stderr (product follow-up)
- Task 9: minor (deferred): e2e assumes package.json bin is an object with dsh key
- Final: minor (deferred): gap-path silent fold can skip announcing one live attempt after an ingest error
- Final: minor (deferred): query() band filter quotes unknown-usage entries; tally-api docs don't say tally/recorded is live-only; ~0.5s event-loop block at 100k rows
- Final: minor (deferred): store.test.ts warning test imports built lib (depends on pretest build)

## 各任务提交范围

- Task 1: complete (commits f76b01c..8f3f829, review clean)
- Task 2: complete (commits 8f3f829..47bf398, review clean)
- Task 3: complete (commits 47bf398..6df88ae, review clean)
- Task 4: complete (commits 6df88ae..eeb4c25, review clean)
- Task 5: complete (commits eeb4c25..06f3d32, review clean)
- Task 6: complete (commits 06f3d32..1243c5c, review clean)
- Task 7: complete (commits 1243c5c..60d92c5, review clean)
- Task 8: complete (commits 60d92c5..c483182, review clean)
- Task 9: complete (commits c483182..ce2e49f, review clean)
- Final fix wave: 9 addressed, 0 open (commits ce2e49f..02cd687); re-review clean
