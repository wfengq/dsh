---
---

0.1.0-beta.1（各包版本已直接写好，不做版本提升）：

- 各包对 `@deepseek-ai/*` 的 peer 范围加上显式的预发布分支（如 `>=0.2.0-0 <0.3.0-0 || >=0.2.1-0 <0.3.0-0`）。按 npm 的规则，`0.1.0-beta.0` 的范围不接受 dsh 的 alpha 版本 `0.2.1-alpha.2`（以及 cordis `4.0.5-alpha.1`、schemastery `3.18.5-alpha.1`）。
- 对账命令的文档改为 `npx dsh-tally@beta reconcile`；构建前清空 `lib/`；仓库统一 LF 换行。
