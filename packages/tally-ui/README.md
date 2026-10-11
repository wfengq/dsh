# dsh-tally-ui

[`dsh-tally`](../tally/README.md) 的参考界面插件，运行在 dsh 的 Web 界面（`dsh --profile web`）里。它只通过同源的 Remote API 命名空间 `tally` 读写 `dsh-tally` 的数据，自己不读凭据、不发起其他网络请求。

## 安装

先安装 `dsh-tally`，再安装本插件，然后重启 dsh：

```sh
dsh plugin --profile web add dsh-tally dsh-tally-ui
```

浏览器端代码只在 dsh 启动时加载，所以安装或升级后需要重启 dsh。需要显示 DeepSeek 余额时，再安装 [`dsh-tally-balance-deepseek`](../balance-deepseek/README.md)。

注意：浏览器端代码只会挂到以包名（`dsh-tally-ui`）命名的 Loader 条目上，请用 `dsh plugin add` 安装，不要在 patch 文件里用路径引用 `lib/client.js`。

## 功能

界面共有六处，下表的“截图”一列是 e2e 测试（`tests/e2e/web.e2e.test.ts`）运行后保存在 `tests/e2e/screenshots/` 里的文件，可以对照查看（截图不提交到仓库）。所有金额都按币种分开显示，不做换算；没有价格时显示“未定价”，不会显示 `¥0`；小于 0.0001 的金额显示为 `<¥0.0001`。

| 位置 | 元素 | 内容 | 截图 |
| --- | --- | --- | --- |
| 输入框下方 | 费用条（`composerDock`） | 本会话费用（有记录后才出现）、今日费用、余额、当前价格时段和距下次变化的倒计时。点击余额立即刷新；刷新失败时继续显示上一次的余额并标注“已过期”，从未成功过时显示失败原因（未配置账号时提示到 dsh 设置里配置 DeepSeek）。“今日”在本地午夜自动切换到新的一天 | `01-conversation.png`、`03-balance.png`、`04-balance-stale.png` |
| 每轮回复末尾 | 本轮费用（`turnTail`） | 这一轮的费用。鼠标悬停显示输入、缓存命中、输出 token、缓存命中率、请求次数（含重试，即这一轮发出的全部请求）和价格版本（链接到价格来源）。修改价格覆盖或重建账本后自动刷新为新的价格 | `01-conversation.png`、`02-turn-details.png` |
| 会话标题栏右侧 | 会话累计（`headerUtilities`） | 本会话（含子代理）的累计费用；点击展开每个子代理会话的费用 | `01-conversation.png` |
| 右侧栏 | 用量看板（`sidebarTab`） | 在右侧栏的“添加标签页”导引里选择“用量”打开。可选今天、近 7 天、近 30 天、本月；包括每个币种在所选范围内的费用合计、每日费用堆叠柱状图（高峰 / 空闲；鼠标悬停在柱子上显示当天该时段的金额）、缓存命中率趋势、按模型 / 工作区 / 会话排行（已删除的会话单独标注）、低谷时段节省、未定价请求提示，以及“导出 CSV”。有新的用量记入后（防抖）以及重连后自动刷新，刷新期间保留原有内容 | `05-dashboard.png` |
| 设置 → 用量与费用 | 设置页（始终显示） | 问题列表（无法读取的会话日志、账本错误并提示重建账本、无法使用的价格覆盖、预算文件错误；没有问题时不显示，问题解决后自动消失）、价格目录版本和每个模型的价格版本、价格覆盖编辑（别名 / 自定义价格）、预算（按日 / 按月，可限定工作区；以“每日预算 · ¥10 · 工作区”的形式列出）、界面元素开关、重建账本 | `06-settings-budget.png`、`08-settings-elements.png` |
| 页面顶部浮层 | 预算提醒（`budgetToast`） | 预算达到 80% 或 100% 时弹出提示，用“每日预算 · ¥10”这样的描述称呼预算（不显示内部 id；找不到对应预算时显示“预算 · ¥10”），约 8 秒后自动消失；多条提醒依次显示 | `07-budget-toast.png` |

其余截图：`09-turn-tail-off.png`（关闭“每轮对话的费用”后新一轮不再显示本轮费用）、`10-after-reload.png`（重新加载页面后费用条数值不变）。

页面断线重连（包括重新加载）后，插件会在收到 `watch` 流的 `hello` 帧时重新拉取全部数据（包括已显示的本轮费用、价格目录、预算和看板），所以重连前后显示的数值一致；修改价格覆盖、重建账本后 `dsh-tally` 也会发出 `hello`，界面随之刷新。回填期间新出现的余额路由（`status` 帧）会立即查询余额。

界面文案有中文和英文两套，跟随 dsh 的界面语言。

## 元素开关

`elements` 下的五个开关控制各个界面元素是否显示，默认都打开。它们是 volatile 配置项：在“设置 → 用量与费用 → 界面元素”里切换后立即生效，不需要重新加载插件，也不需要刷新页面。设置页里本插件的部分本身不能关闭。

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `elements.composerDock` | `true` | 输入框下方的费用条。 |
| `elements.turnTail` | `true` | 每轮回复末尾的本轮费用。 |
| `elements.headerUtilities` | `true` | 会话标题栏的会话累计费用。 |
| `elements.sidebarTab` | `true` | 右侧栏的用量看板（关闭后从导引中移除）。 |
| `elements.budgetToast` | `true` | 预算达到提醒线时的弹出提示。 |

只有在本机（loopback）打开的页面才能修改设置：远程访问的页面处于 memory 模式，设置只保存在浏览器里，开关、价格覆盖会显示为只读并说明原因。预算不走配置文件，而是通过 Remote API 写入 `dsh-tally` 的预算文件。

也可以直接写在 profile 的 patch 文件里：

```yaml
- id: tally-ui
  name: dsh-tally-ui
  config:
    elements:
      turnTail: false
```

## 构建说明

`pnpm run build`（仓库根目录）依次执行：

1. `tsc -p .`：编译 Host 端入口 `src/index.ts` 到 `lib/index.js`。Host 端只声明插件名和配置项（界面元素开关），`apply` 为空。
2. `tsc -p tsconfig.client.json`：只生成浏览器端代码的类型声明，输出到 `lib/types`。
3. `tsdown`：把 `src/client/index.ts` 打包成 `lib/client.js`。配置照搬 dsh 官方 `packages/client/tsdown.client.ts` 里的 `clientConfig()`：
   - 格式为 `cjs`，平台为 `browser`，输出文件名固定为 `client.js`，带 sourcemap；
   - 用 banner 和 footer 把整个模块包成 `window.__ModuleLoader__.load({ id: 'dsh-tally-ui', factory: (require) => { … } })`，由 dsh 的客户端模块加载器在需要时执行；
   - 只有宿主共享模块保持为 `require()`（tsdown 0.23 的 `deps.neverBundle`，即旧的 `external`），其余全部内联。
4. `node scripts/check-client-bundle.mjs packages/tally-ui/lib/client.js`：扫描 bundle 里所有 `require("…")`，出现共享模块表以外的模块就报错退出。

**bundle 共享模块限制**：dsh 的客户端模块加载器只向插件提供固定的宿主共享模块表：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`。bundle 里 `require()` 其他任何模块都会在浏览器中失败，所以 zod、`dsh-tally/remote`、本包自己的代码和样式全部内联；其他 `@deepseek-ai/dsh-client-*` 包只能 `import type`（用于类型和声明合并），不能引入运行时值。目前的 bundle 实际只引用了 `react`、`react/jsx-runtime` 和 `@deepseek-ai/dsh-client-ui-primitives`。

**样式**：采用“factory 执行时注入 `<style>`”的方式，不使用 `.module.css`。`src/client` 下的 `.css` 文件在打包时被转换成一段代码，factory 执行时向 `document.head` 插入一个 `<style data-plugin="dsh-tally-ui" data-plugin-css="dsh-tally-ui/<文件名>">`（与 dsh 官方插件的标记相同，插件卸载时由 dsh 回收）。类名不做哈希，统一加 `dsh-tally-` 前缀避免冲突。样式只使用 `--dsw-alias-*` 语义变量和 `--dsw-elevation-*`，不写主题选择器和字面颜色值。

**接口描述**：浏览器端调用 Remote API 需要一份带严格编解码器的接口描述（`TypertRemoteContribution`）。dsh 官方用构建期生成器产出这份描述，但生成器依赖 dsh 仓库内部的工作区结构，所以由 `dsh-tally` 手写（`dsh-tally/remote`，见 `packages/tally/src/remote/contract.ts`），本包在启动时用其中的 `mountTallyRemote(ctx)` 挂载：如果另一个客户端插件已经挂载过 `tally`（`remote.tally` 服务已存在），就跳过挂载，直接使用已有的命名空间；否则调用 `ctx.remote.$mount()`。两个插件同时挂载时，输掉的一方会收到宿主的 `client api: direct method tally/… is already mounted`（或 Typert 注册表的 `Remote package "dsh-tally" is already registered`），同样视为成功。

**执行中的判断规则（Task 1）**：两条备用方案都没有用到，最终的端到端验收也是在这个前提下通过的。

- Host 端：编译后的 `lib` 里，标注了 `@Remote` 的方法能被 dsh 网关直接识别（网关从运行中的服务读取装饰器标记，参数名从编译后的函数读取），不需要改用 `bindTypertRemote` 手动注册。
- 浏览器端：手写的接口描述可以被 `ctx.remote.$mount()` 接受，不需要改用官方生成器 `typertPlugin`。因此也不需要在发布前复核生成器版本与 dsh 版本的对应关系。

**宿主表单接口的两个细节**（在真实 dsh 中验证时发现）：

- 宿主的 `ConfigForm` 是一个类，`getSnapshot` / `subscribe` 依赖 `this`，传给 React 的 `useSyncExternalStore` 前必须包一层，不能直接传方法引用。
- `ConfigForm.set(field, value)` 的 `field` 只是一层键名，`'elements.turnTail'` 会被当成一个字面键而被拒绝；嵌套字段要用 `mutate([{ op: 'set', path: ['elements', 'turnTail'], value }])`。

## 测试

- `pnpm test`：组件和数据层的单元测试（jsdom），以及 bundle 共享模块检查。
- `pnpm test:e2e`：在真实的 `dsh --profile web` 中，用 Chromium 依次验证费用条、本轮费用（含悬停详情）、会话累计、余额（含刷新失败后的“已过期”）、用量看板（含 CSV 下载）、设置页（新建预算后出现预算提醒、关闭 `turnTail` 后新一轮不再显示本轮费用）以及页面重新加载后数值不变；全过程页面没有 `console.error`，dsh 的 stderr 没有 `ExperimentalWarning` 和 `failed to import`。模型请求由 `@deepseek-ai/dsh-llm-mock-server` 应答，余额由测试内的本地服务应答。

## 许可证

MIT
