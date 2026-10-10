# DeepSeek Harness（dsh）仓库与插件生态调研

> 调研日期：2026-10-10
> 数据来源：官方仓库源码（`deepseek-ai/deepseek-harness`，`master` 分支 `d743267`，提交时间 2026-10-09）、`awesome-dsh-plugin` 仓库自带的数据文件、GitHub 搜索（star 数取自 2026-10-10），以及若干社区文章。
> 口径说明：star 数是当天快照；awesome 列表里的 star 和下载量是该仓库在 **2026-08-19** 采集的旧数据，只能用来比较插件之间的相对热度。

---

## 1. 结论摘要

1. **DeepSeek Harness（`dsh`）是 DeepSeek 官方开源的 agent harness**，2026-08-13 发布开发者预览版，MIT 协议，当前版本 `0.2.1-alpha.2`。官方明确说明后续会有破坏性变更。它主体是 TypeScript monorepo，内置 Web UI、headless、SDK（TS 和 Python）、ACP 和 Electron 桌面端。
2. **核心设计是“一切皆插件”**：底层是 [Cordis](https://github.com/cordiverse/cordis) 插件框架。模型适配器、工具、会话日志、沙箱、UI，甚至 agent loop 本身都是可以替换的插件。系统里没有特权内核。扩展的办法是把插件挂到插件树上，所有注册都是副作用，插件卸载时会自动撤销。
3. **插件分发直接用 npm/pnpm**：在 `package.json` 里声明 `dsh.bundle.patch` 就是一个可安装的“组合包（bundle）”，用 `dsh plugin --profile <p> add <spec>` 安装（内部转发给 pnpm），通过分层 YAML patch 组合进 profile。官方没有中心化的插件商店，商店都是社区做的。
4. **生态在两个月内急剧膨胀**：`awesome-dsh-plugin` 已收录 **4481** 个可安装插件，分 23 类。数量最多的是 UI 增强（778）、工具与能力（585）、开发与运行时（321）和会话与消息（292）。GitHub 上带 `dsh-plugin` topic 的仓库有 **18562** 个。
5. **社区补的主要是官方的短板**：一是视觉能力（DeepSeek 模型是纯文本的，modlens、vision-router 等外挂视觉插件下载量很高），二是插件市场与发现，三是桌面和移动客户端，四是 IM 接入、记忆和多 agent 协作。
6. **风险偏高**：插件在宿主进程里运行，权限和用户本人一样，**不受工作区沙箱约束**。awesome 列表的静态扫描显示，3844 个插件中有 454 个触发“红线”，其中 354 个同时读取凭据并访问网络。另外，官方默认会把**当前启用的插件包清单**附带在发往 DeepSeek 官方 API 的请求里（可以关闭，见 §5.3）。
7. **star 数要谨慎看待**：官方仓库约 24.7 万 star，不少两个月内新建的插件仓库也有数千 star，但 fork 和 issue 很少。评估插件更可靠的信号是下载量、能否装上、维护是否活跃。

---

## 2. 官方仓库：`deepseek-ai/deepseek-harness`

| 项 | 内容 |
|---|---|
| 仓库 | https://github.com/deepseek-ai/deepseek-harness |
| 文档 | https://deepseek-harness.github.io/deepseek-harness/ |
| 协议 / 版本 | MIT / `0.2.1-alpha.2`（开发者预览） |
| 语言 / 工具链 | TypeScript；Node `^22.19 \|\| >=24`；pnpm 11；tsdown；vitest；oxlint |
| 体量 | 约 1.5 万个文件，`packages/` 下有 50 多个能力分组 |
| GitHub 数据 | ★ 246,774 · fork 29,624（2026-10-10）。issue 数为 0，反馈渠道是 GitHub Discussions |
| 论文 | Cordis 的设计论文是 *A Programming Paradigm for Spatiotemporal Composability*（arXiv 2608.25512） |

### 2.1 运行方式

```sh
npx @deepseek-ai/dsh web          # 默认在 http://127.0.0.1:3080 启动 Web UI
dsh --profile <name>              # 用指定 profile 启动
dsh --profile web --dump-config   # 打印最终组合出的插件树
```

内置的 profile 模板有 `web`、`headless`、`sdk`、`sdk-minimal` 和 `acp`。`apps/` 下包含 `cli`、`web`、`desktop`（Electron）和 `desktop-host`。

### 2.2 架构要点

- **Profile 和组合包（bundle）**：一个运行中的 dsh 是一棵插件树，由多层配置按顺序叠加而成：
  1. profile 中按顺序列出的各个 bundle 的 patch（第一个是 `@deepseek-ai/dsh-base`）；
  2. profile 自己的 `cordis.patch.yml`；
  3. `$DSH_HOME/cordis.patch.yml`；
  4. 命令行里的 `--patch` overlay。

  patch 按 `id` 定位某一行配置，并**整体替换**该行的 `config`，不做深度合并。
- **能力 seam**：每项能力拆成三个角色：Service Definition（接口）、Service Provider（实现）和 Consumer（通常是面向模型的工具）。比如把 fs 和 process 的提供方换成远程沙箱，Bash、PTY 和 LSP 会一起迁过去。
- **事件是扩展点**，分三个域：
  - 会话事件：持久化的事实，写入日志并广播；
  - `agent/*` 事件：用于拦截正在运行的 agent；
  - 能力事件：`fs/*`、`tools/*` 等。

  `agent/pre-step`、`agent/request`、`llm/stream`、`tools/pre-execute`、`tools/execute`、`tools/post-execute` 是 waterfall 事件，监听器必须调用 `next()` 才能把调用传下去。
- **会话日志是模型上下文的唯一来源**：原则是“模型可见即已记录”。插件如果要新增模型可见的输入，必须通过会话事件，这样 fork、恢复和回放才能保持一致。
- **扩展落点**：

  | 想做的事 | 用法 |
  |---|---|
  | 加模型 | `ctx.llm` |
  | 加工具 | `ctx.tools` |
  | 加用户命令 | `ctx.commands` |
  | 加 shell 后端 | `ctx.shell` |
  | 加沙箱 | `ctx.sandbox` |
  | 注入上下文 | `agent.inject()` |
  | 加 UI | 驱动 `ctx.agents`，并从 `session/event` 渲染 |
  | 为会话组装不同能力集 | 写一个 agent preset |

### 2.3 内置能力一览（节选）

| 类别 | 内容 |
|---|---|
| 模型 | 官方 DeepSeek 适配器（支持 API key 和账号 token 两种鉴权）；通过 `llm-pi-ai` 接入第三方提供商（anthropic、openai、moonshotai、zai 等），也支持自定义网关，协议可选 OpenAI Chat、OpenAI Responses 或 Anthropic Messages。暂不支持 OAuth 登录类提供商，例如 Codex |
| 工具 | `bash`/`pwsh`、`read`/`write`/`edit`/`str_replace_editor`、`glob`/`grep`、`lsp`、`web_search`/`web_fetch`（搜索后端可选 DeepSeek、Exa、Perplexity）、`todo_write`、`subagent`、`workflow`、`run_code`（PTC）、`terminal_*`、`schedule_*`、`*_goal`、`skill`、MCP 资源、`plugin_manager` 等，共约 70 个 |
| Subagent 提供方 | 进程内 fork/spawn、dsh SDK、ACP、**Claude Code**、**Codex** |
| 兼容桥 | `hooks-claude-code` 可以直接复用 Claude Code 的 `hooks.json` 和 settings 里的钩子；`hooks-codex` 同理 |
| 沙箱 | bwrap、Landlock、Seatbelt、Windows ACL |
| 接入 | MCP 客户端、TypeScript 和 Python SDK（换行分帧的 JSON-RPC）、ACP 服务器、GitHub webhook |
| Agent 预设 | `standard`、`ptc`、`minimal`、`cordis`（创造模式，可以自己修改插件） |
| 官方可选 bundle（随安装附带，默认关闭） | session-search、ralph、terminal、badge-skill、session-titles、agent-team、voice-input、cot-translation、auto-review、inspector、worktree |

### 2.4 插件开发与发布流程

```text
hello-plugin/
├── package.json       # "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
├── cordis.patch.yml   # - insert: [{ id: hello, name: dsh-hello-plugin }]
└── index.js           # export const name = '...'; export function apply(ctx) {...}
```

- **依赖声明**：需要和宿主共享同一实例的 dsh 包（比如 cordis），要同时写进 `peerDependencies` 和 `devDependencies`。运行时会解析到安装目录里的唯一 cordis 实例。
- **安装**：`dsh plugin --profile web add <npm 包 | github:owner/repo | 本地路径>`。安装前会检查 DSH peer 版本是否兼容，不兼容就拒绝。也可以用 `allow-version … --accept-risk` 为某个精确版本添加豁免。
- **镜像回退**：注册表默认按顺序回退到 `registry.npmmirror.com`，对国内网络友好。私有源不会回落到公共源。
- **构建脚本审批**：依赖的 install 脚本默认被 pnpm 拦截，需要用户显式批准。
- **热更新**：开启 HMR 后，安装或启停插件可以立即生效；替换已经安装的包仍然需要重启。
- **Agent 自行管理插件**：在 `cordis`（创造）预设下，agent 可以通过 `plugin_manager` 工具自己安装插件，每次操作都需要用户审批。

---

## 3. 社区生态全景

### 3.1 规模与分类（awesome-dsh-plugin，共 4481 条）

| 分类 | 数量 | 分类 | 数量 |
|---|---:|---|---:|
| 🎨 UI 增强 | 778 | 🔔 通知与集成 | 172 |
| 🛠️ 工具与能力 | 585 | 🎭 主题与外观 | 158 |
| 🧑‍💻 开发与运行时 | 321 | 🔒 安全与权限 | 151 |
| 💬 会话与消息 | 292 | 📱 远程与移动端 | 138 |
| 🔁 工作流与自动化 | 267 | 🎮 娱乐 | 136 |
| 💰 用量与计费 | 236 | 🔀 Git 与代码评审 | 111 |
| 🔌 模型与账号接入 | 213 | 🖼️ 视觉与多模态 | 109 |
| 🧠 记忆 | 208 | 🌐 浏览器与网页 | 98 |
| 🧩 技能包 | 178 | 🛒 插件市场与管理 | 80 |
| | | 🐧 WSL 与 Windows 互操作 | 77 |
| | | 📄 文档与渲染 | 67 |
| | | 🎙️ 语音与音频 | 65 |
| | | 🆔 身份与通信 | 24 |
| | | 🧭 AGI 架构探索 | 17 |

收录标准：插件必须声明 `dsh.bundle`，能用 `dsh plugin add` 装上，功能与描述一致，并且仍在维护。列表**不做排名，也不做安全审查**。

### 3.2 按下载量排名的头部插件（2026-08-19 快照）

| 插件 | 下载量 | 作用 |
|---|---:|---|
| [dsh-market/dsh-market](https://github.com/dsh-market/dsh-market) | 82,491 | 内嵌在 dsh 里的可视化插件市场，支持一键安装、升级和换主题 |
| [liustack/modlens](https://github.com/liustack/modlens) | 63,829 | 给纯文本模型外挂视觉：粘贴图片后得到结构化的 OCR、版面和语义 JSON |
| [zhu1090093659/dsh-web-ui](https://github.com/zhu1090093659/dsh-web-ui) | 59,648 | Web UI 增强插件合集 |
| [omdsh-dev/DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) | 39,717 | 可扩展的侧边栏底座，内置文件、终端、侧边对话、Git 和子代理页面 |
| [ysr666/dsh-vision-router](https://github.com/ysr666/dsh-vision-router) | 21,679 | 内置免 key 的视觉链和像素级视觉工具 |
| [Anionex/dsh-vision-toolkit](https://github.com/Anionex/dsh-vision-toolkit) | 17,248 | 视觉工具箱：多图问答、长截图 OCR、UI 还原 |
| [ccch1mneyyy/dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) | 16,959 | 终端 TUI 前端（基于 Ink）。README 自称“官方首推”，未核实 |
| [NanmiCoder/dsh-agent-teams](https://github.com/NanmiCoder/dsh-agent-teams) | 10,525 | 多 agent 团队协作：任务分配、并行执行、成员之间通信 |
| [shaobeichen/dsh-pocket](https://github.com/shaobeichen/dsh-pocket) | 10,411 | 手机扫码远程访问本机上的 dsh web |
| [MicroMilo/upstream-radar](https://github.com/MicroMilo/upstream-radar) | 9,808 | 安全与权限类插件 |
| [vectorize-io/hindsight](https://github.com/vectorize-io/hindsight) | 9,558 | 记忆层集成 |
| [liustack/modsearch](https://github.com/liustack/modsearch) | 8,781 | 浏览器与网页搜索 |
| [PlutoKeating/dsh-lark-bot](https://github.com/PlutoKeating/dsh-lark-bot) | 7,122 | 飞书机器人接入 |
| [bowenliang123/dsh-context](https://github.com/bowenliang123/dsh-context) | 6,612 | 上下文可视化：组成、演进、压缩和剪枝 |

### 3.3 按功能整理的重点仓库（★ 为 2026-10-10 数据）

**插件发现与市场**

| 仓库 | ★ | 说明 |
|---|---:|---|
| [awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) | 18.3k | 最主要的精选列表，附带能力扫描数据 |
| [dsh-market/dsh-market](https://github.com/dsh-market/dsh-market) | 6.0k | 内嵌市场 |
| [AdamPlatin123/dsh-plugin-radar](https://github.com/AdamPlatin123/dsh-plugin-radar) | 1.5k | 自称发现 2.1 万多个候选插件，并在 k8s 上做了 1.3 万多次运行级实测 |
| [0xsline/awesome-deepseek-harness](https://github.com/0xsline/awesome-deepseek-harness) | 1.2k | 生态列表 |
| [LivXue/dsh-plugin-shop](https://github.com/LivXue/dsh-plugin-shop) | 1.0k | 插件商店 |
| [awesome-dsh-plugin/dsh-find-plugin](https://github.com/awesome-dsh-plugin/dsh-find-plugin) | — | 对话式找插件 |

**客户端与壳**

| 仓库 | ★ | 说明 |
|---|---:|---|
| [anywhere-labs/dsh-desktop](https://github.com/anywhere-labs/dsh-desktop) | 30.3k | 桌面端 |
| [dataelement/dsh-desktop](https://github.com/dataelement/dsh-desktop) | 12.9k | 桌面端 |
| [zhu1090093659/dsh-web](https://github.com/zhu1090093659/dsh-web) | 8.6k | Web 插件聚合，通过“创意工坊”分发 |
| [dsh-tauri/deepseek-harness-desktop](https://github.com/dsh-tauri/deepseek-harness-desktop) | 3.2k | Tauri 桌面端，安装包约 8MB |
| [DSH-APP/DSHA](https://github.com/DSH-APP/DSHA) | 1.0k | Android 端，免 root、免 Termux |
| [ningbainb/deepseek-harness-desktop](https://github.com/ningbainb/deepseek-harness-desktop) | 0.8k | Windows 桌面端 |

**多引擎工作台**（把 dsh 和其他 agent 放在同一个界面里）

| 仓库 | ★ | 说明 |
|---|---:|---|
| [Devin-AXIS/iPolloWork](https://github.com/Devin-AXIS/iPolloWork) | 6.8k | 同时支持 Codex、DSH 和 OpenCode |
| [zhukunpenglinyutong/desktop-cc-gui](https://github.com/zhukunpenglinyutong/desktop-cc-gui) | 4.5k | Tauri 应用，支持 Claude Code、Codex、Gemini、OpenCode 和 DSH |

**能力插件**

| 方向 | 代表仓库 |
|---|---|
| 视觉 | modlens（4.2k）、dsh-vision-router（1.1k）、dsh-vision-toolkit（0.9k） |
| 记忆 | [volcengine/OpenViking](https://github.com/volcengine/OpenViking)（39.6k）、[MemTensor/MemOS](https://github.com/MemTensor/MemOS)（11.8k）、[EverMind-AI/EverOS](https://github.com/EverMind-AI/EverOS)（13.4k）、[zilliztech/memsearch](https://github.com/zilliztech/memsearch)、[agentscope-ai/ReMe](https://github.com/agentscope-ai/ReMe)、[plastic-labs/honcho](https://github.com/plastic-labs/honcho) |
| 设计 | [nexu-io/open-design](https://github.com/nexu-io/open-design)（100k）、[Devin-AXIS/deepseek-design](https://github.com/Devin-AXIS/deepseek-design) |
| 浏览器 | [omdsh-dev/dsh-browser](https://github.com/omdsh-dev/dsh-browser)、[Tencent/BrowserSkill](https://github.com/Tencent/BrowserSkill) |
| IM 接入 | [xmanrui/dsh-im](https://github.com/xmanrui/dsh-im)（9 个渠道）、dsh-lark-bot、[Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge) |
| 路由与预设 | [yjh051108/dsh-routing-suite](https://github.com/yjh051108/dsh-routing-suite)、[xiaobright/dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard) |
| 跨 harness 通用 | [tt-a1i/archify](https://github.com/tt-a1i/archify)、[Q00/ouroboros](https://github.com/Q00/ouroboros)、[strukto-ai/mirage](https://github.com/strukto-ai/mirage)、[crafter-station/petdex](https://github.com/crafter-station/petdex)、[xiufengsun/TokenTracker](https://github.com/xiufengsun/TokenTracker) |

**文档与教程**

- [alchaincyf/deepseek-harness-orange-book](https://github.com/alchaincyf/deepseek-harness-orange-book)：橙皮书，包含系统提示词和原始会话日志实测。
- [Electricitysheep/dsh-handbook](https://github.com/Electricitysheep/dsh-handbook)：从 0 到 1 的手册。
- [libukai/awesome-deepseek-harness](https://github.com/libukai/awesome-deepseek-harness)：指南与资源合集。
- 官方仓库里的 `docs/cordis-tutorial/`（共 7 章）和 `docs/cookbook/`。

### 3.4 生态特征观察

- **“跨 harness 适配”已经成为常规做法**：很多原本面向 Claude Code、Codex 或 OpenCode 的 skill 和工具（记忆、设计、图表）只加了一层 `dsh.bundle` 适配就进入了生态。dsh 自身也通过 `subagent-claude-code`、`hooks-claude-code` 反向兼容 Claude Code 生态。
- **topic 被大量蹭用**：PicGo、nocobase、reactive-resume、WeKnora 等与 dsh 关系不大的老牌仓库也打上了 `dsh-plugin` topic。**带这个 topic 不代表能装**；判断能否安装要看 `package.json` 里有没有 `dsh.bundle`。本次没有逐个核实这些仓库。
- **UI 类插件占比最高**（17%）。官方 Web UI 提供了 slot 和 renderer 扩展点，社区大量在这层做定制，甚至做了一批“皮肤”和娱乐插件。

---

## 4. 相关但非 dsh 的“DeepSeek 驱动 harness”

这一节是为了避免概念混淆。以下项目由 DeepSeek 模型驱动，但**不是 dsh 插件**：

| 项目 | 说明 |
|---|---|
| DeepSeek 官方 Anthropic 兼容 API | 可以直接给 Claude Code 当后端使用。官方文档给出的模型映射是：`claude-opus*` → `deepseek-v4-pro`，`claude-sonnet*` 和 `claude-haiku*` → `deepseek-v4-flash` |
| [esengine/DeepSeek-Reasonix](https://github.com/esengine/DeepSeek-Reasonix)（35.8k） | 独立的 DeepSeek coding agent（Go 语言，TUI） |
| Deep Code（lessweb/deepcode-cli） | 被 DeepSeek API 文档列为社区集成的终端 agent（据搜索结果，未单独核实） |
| DeepSeek TUI | 单二进制的终端 agent（据搜索结果，未单独核实） |
| [qiz029/dscode](https://github.com/qiz029/dscode) | 独立的 DeepSeek coding agent harness |
| PsChina/deepseek-as-subagent | 在 Claude Code 或 Codex 中把 DeepSeek 当作子 agent 使用（据搜索结果，未单独核实） |
| [CommandCodeAI/command-code](https://github.com/CommandCodeAI/command-code)、[zhayujie/CowAgent](https://github.com/zhayujie/CowAgent)、[zhnt/loushang](https://github.com/zhnt/loushang) | 多模型的通用 agent harness，都支持 DeepSeek |

---

## 5. 安全与合规风险

### 5.1 官方立场（SAFETY.md）

- 本软件是实验性的开发者预览版，**没有经过安全审计**，不能用于生产。
- 沙箱和审批机制只能降低风险，不能保证隔离。
- 官方建议在一次性虚拟机或容器中运行，只授予最小权限。

### 5.2 插件层面

- 插件的 host 端代码在**宿主进程**里运行，**不受工作区沙箱和工具审批约束**，权限等同于用户本人。
- awesome 列表用 `dsh-trust-check@0.1.13` 做了一次静态扫描（2026-09-24），覆盖 3844 个插件：

  | 声明或探测到的能力 | 插件数 |
  |---|---:|
  | fs-read | 2883 |
  | fs-write | 2262 |
  | env | 2207 |
  | network | 2184 |
  | shell | 1635 |
  | credentials | 455 |
  | dynamic-code | 347 |

  有 **454** 个插件触发红线：
  - **354** 个同时“读取凭据或密钥，并且有网络访问”；
  - 20 个在安装时执行 postinstall；
  - 其余多为使用明文 http，或直连 `169.254.169.254` 这类云元数据地址。
- 需要特别留意的类别：
  - **越狱类**插件，例如 [YuJunZhiXue/dsh-purge](https://github.com/YuJunZhiXue/dsh-purge)；
  - 宣称**“免登录、免 Key、免费无限量前沿模型”**的模型接入插件，例如 [Ebony-Vinyl/dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model)。这类插件的流量去向和合规性都不明确，提示词和代码可能被第三方中转；
  - 打包大量第三方插件的“全家桶”客户端。

### 5.3 数据外发

- 官方包 `@deepseek-ai/dsh-plugin-package-inventory-deepseek` **默认开启**（`enabled: true`）。它会在每次发往 DeepSeek 官方 API 的请求里附带 `dsh_plugin_packages` 字段，内容是当前激活的插件包名和版本，用于请求诊断。
- 不想上报的话，可以在 profile 的 `cordis.patch.yml` 里把该插件配置为 `enabled: false`。

---

## 6. 建议与后续方向

1. **评估是否引入**：如果想用一个可以深度定制、能替换核心部件的 agent 底座，dsh 的 seam 和事件设计是目前开源 harness 里最彻底的。但 API 还处于预稳定阶段，版本升级时插件需要跟着改（peer 版本检查会拦下不兼容的插件）。
2. **选插件的原则**：
   - 优先选官方可选 bundle 和下载量高、仍在维护的插件；
   - 安装前看一下源码，以及 awesome 列表 `data/capabilities.json` 里该插件的能力和红线；
   - 涉及凭据的插件，放在隔离环境里试用。
3. **如果要自己开发插件**，推荐这样入门：
   - 先读 `docs/cordis-primer` 和 `docs/cordis-tutorial/01-07`，再读 `docs/architecture` 和 `docs/cookbook/extension-cookbook`；
   - 从“注册一个工具”或“监听 `tools/*` 事件”开始；
   - 用 `--patch` 在本地调试，再按 `docs/user/develop/basic/publish` 打包成 bundle；
   - 给仓库加上 `dsh-plugin` topic，并提交到 awesome 列表。
4. **社区还缺什么（机会点）**：
   - 带签名和信誉的插件仓库（目前只有静态扫描）；
   - 插件权限声明，以及运行时最小权限隔离；
   - 企业私有插件源的治理；
   - 系统化的插件兼容性回归（plugin-radar 已经在做运行级实测）。

---

## 附录：本次调研用到的原始数据位置

- 官方仓库：`docs/architecture.zh.md`、`packages/README.zh.md`、`packages/boot/plugin-manager/README.zh.md`、`packages/boot/app-boot/src/profile.ts`（`OPTIONAL_BUNDLES`）、`docs/user/develop/basic/publish.zh.md`、`docs/user/guide/providers.zh.md`、`SAFETY.zh.md`、`packages/llm/plugin-package-inventory-deepseek/README.zh.md`
- awesome-dsh-plugin：`README.zh.md`（分类计数）、`data/stars.json`、`data/downloads.json`、`data/capabilities.json`
- 外部文章：
  - [DeepSeek API 文档：Anthropic API](https://api-docs.deepseek.com/guides/anthropic_api)
  - [CSDN：DeepSeek Harness 插件系统使用指南](https://blog.csdn.net/zhonglinzhang/article/details/163952349)
  - [博客园：DeepSeek Harness 2026 开发者预览版指南](https://www.cnblogs.com/sing1ee/p/22455466)
  - [tonybai.com：DeepSeek 开源 Harness](https://tonybai.com/2026/08/14/deepseek-harness-everything-is-a-plugin/)（本次抓取失败，未引用其内容）
