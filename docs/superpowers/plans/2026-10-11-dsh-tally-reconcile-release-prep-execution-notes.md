# dsh-tally 对账、节假日、兼容性 CI 与发布准备（计划 4）执行记录

> 执行方式：在当前会话中逐任务实现（TDD），最后由独立审查者做一次全分支审查，再统一修复。下面的条目原样摘自执行台账（英文）。

## 执行中做出的裁决（Rulings）

- Task 1: Ruling: brief's band table uses dates before the price versions' effectiveFrom (2026-10-10), where quote() returns null — test those rows with resolveBand(windows, holidays, at) and keep quote() for the 2027 row — cost if wrong: none
- Task 1: Ruling: three existing tests (catalog holidays empty, quote/bandAt/remote band flagging 2026-10-14 as calendar-missing) encoded "no 2026 calendar"; updated to the new data and moved the missing-calendar assertions to 2027 — cost if wrong: none
- Task 3: Ruling: TallyStore.open creates/rebuilds the schema on version mismatch — added TallyStore.openReadOnly (readOnly handle, errors on missing file or version mismatch) so reconcile never mutates the ledger — cost if wrong: none
- Task 3: Ruling: LedgerDay.currency is `Currency | null` (null when a day×model line priced nothing) instead of plan's `Currency`; such lines carry only counts that feed hints — cost if wrong: one nullable field in an internal type
- Task 3: Ruling: report and JSON also list bill lines the parser skipped (line + reason), per Review Focus 1 "不能静默丢弃" — cost if wrong: none
- Task 3: Ruling: `dsh-tally --help` / bare command print usage; reconcile verified via `node packages/tally/lib/cli.js reconcile --help` (the bin is not linked at the workspace root, so `pnpm exec dsh-tally` is unavailable before install) — cost if wrong: none
- Task 4: Ruling: the brief's script (dsh* packages only) failed on alpha — dsh 0.2.1-alpha.2 needs cordis ~4.0.5-alpha.1 / schemastery ~3.18.5-alpha.1 / cordis-plugin-loader ~1.0.6-alpha.1, and keeping 4.0.4/1.0.5 installed two cordis copies (session-title-first-prompt-llm "failed to import"; then tsc Context mismatches). Script now also pins framework packages (cordis, schemastery, cosmokit, cordis-plugin-*) to the minimum of the range dsh (or cordis, for cosmokit) declares, and deletes pnpm-lock.yaml after a change so stale transitive versions are not kept — cost if wrong: CI resolves a fresh graph each run (slower, less reproducible on alpha)
- Task 4: Ruling: workflow installs Chromium with `pnpm exec playwright install --with-deps chromium` (uses the repo's pinned playwright) instead of the brief's npx — cost if wrong: none
- Task 5: Ruling: initial changeset is empty (no bump) instead of the brief's "all five minor" — in 0.x a minor bump (0.1.0→0.2.0) falls outside the packages' own ^0.1.0 / ">=0.1.0 <0.2.0" ranges, so changesets escalated dsh-tally, dsh-tally-api and dsh-tally-ui to major (1.0.0); never-published packages should ship as 0.1.0 — cost if wrong: first release is 0.1.0 instead of 0.2.0
- Task 5: Ruling: @changesets/cli pinned to 2.31.1 (latest 2.x, per plan) though 3.0.3 exists — cost if wrong: an upgrade later
- Task 5: Ruling: `changeset status` needs `--since=origin/main` here (no local main ref) — documented by usage, no config change — cost if wrong: none
- Final: Ruling: re-graded Minor "\"1,2\" silently becomes 12" to Important — a silently wrong amount defeats reconciliation and the user cannot notice it — enters the fix pass
- Final: Ruling: reviewer's "Declined to judge" items (action-setup version duplication, holiday byte-exactness vs gov.cn, holidayMissingCount re-quoting cost, linked vs fixed changesets, changesets 2.x pin, lockfile churn, framework minimum pinning, deleted sessions included in amounts, 2026 holidays predating current price versions, mandatory --format csv, empty initial changeset, trust-check version) — all stand as implemented: none changes what a user gets today beyond what the ledger already records — cost if wrong: small follow-ups

## 任务完成与验证

- Task 1: complete (commits fd4b9a5..40626aa, tests: pnpm test →    Duration  8.69s (transform 2.00s, setup 0ms, collect 5.97s, tests 6.43s, environment 1.55s, prepare 3.09s, typecheck 1.59s))
- Task 2: complete (commits 40626aa..7b4d648, tests: pnpm test →    Duration  8.31s (transform 1.80s, setup 0ms, collect 5.76s, tests 6.44s, environment 1.25s, prepare 2.87s, typecheck 1.63s))
- Task 3: complete (commits 7b4d648..dae8e2c, tests: pnpm test →    Duration  8.01s (transform 1.88s, setup 0ms, collect 5.47s, tests 6.45s, environment 1.19s, prepare 2.93s, typecheck 1.62s))
- Task 4: alpha verification (temp worktree, script against live npm): 35 deps switched; pnpm test 559/559, typecheck clean, test:e2e 10/10, test:perf 2/2 — all green; latest channel: 0 changes
- Task 4: complete (commits dae8e2c..2b6246e, tests: pnpm test →    Duration  9.60s (transform 2.23s, setup 0ms, collect 5.95s, tests 7.94s, environment 1.36s, prepare 3.46s, typecheck 1.74s))
- Task 5: complete (commits 2b6246e..ac49013, tests: pnpm test →    Duration  13.96s (transform 1.86s, setup 0ms, collect 12.43s, tests 8.25s, environment 1.33s, prepare 3.24s, typecheck 1.86s))

## 全分支终审与修复

- Final review (opus, fd4b9a5..ac49013): With fixes — Important: (1) day×model lines that priced nothing vanish unless the bill has the same key; (2) ledger model names not canonicalised (catalog aliases never reconcile); (3) skipped-line numbers wrong after blank lines / multi-line fields; (4) skipped bill lines don't affect exit code or headline; all-skipped path hides reasons; (5) CLI can't use the user's route mapping / overrides
- Final review: complete (plan 4 range fd4b9a5..HEAD)

## 暂缓处理的小问题

- Final: minor (deferred): read-only open in an unwritable dir fails on WAL -shm creation (retry with immutable=1 or hint); missingInBill prints 差异 — not 100%; "账本中没有这一行" wording when ledger has unpriced requests; --from > --to gives empty OK run; rows outside --from/--to filtered silently; unknown subcommand usage to stdout; date regex accepts 2026-13-45; refunds/negative amounts unsupported; empty currency cell ignores --currency; unterminated quote swallows rest of file; tolerance compared after 6-dp rounding; CI actions@v4 on Node 20, push+pull_request double runs, schedule/push share concurrency group; channel script: minimum() only strips ~^=, null version with --framework but no --registry-version, peer ranges never checked against channel version; packaging test uses npm pack (doesn't verify workspace: rewriting) and doesn't clean lib/; no tests for holidayCalendarMissing/unknownUsage hints in compare/CLI

## 后续处理（2026-10-11）

上面“暂缓处理的小问题”已全部处理，每一项都先写了失败的测试：
- 对账：退款金额、空币种单元格回退到 `--currency`、引号未闭合时报错、按精确比例判定容差、只有一边有数据的行显示 100%、`--from` 晚于 `--to` 和无效日期报参数错误、报告说明不在日期范围内的账单行数、未知命令的用法输出到 stderr、不可写目录中的账本可以只读打开（没有 `-wal` 时用 immutable 方式）。
- CI：`actions/checkout`、`actions/setup-node` 升到 v5；push 只在 main 上触发，避免 PR 分支每次提交跑两遍；并发组加入事件名。
- 版本切换脚本：无法化为单一版本的范围直接报错；拿不到 dsh 版本时报错；渠道版本不在本仓库声明的 dsh peer 范围内时以退出码 3 失败（不再静默通过）。
- 打包测试：检查发布清单里没有 `workspace:`（用 `pnpm pack`），以及没有来自已删除源文件的旧构建产物。
- 对账的 `holidayCalendarMissing`、`unknownUsage` 提示补了测试。
