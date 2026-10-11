# dsh-tally-ui

[`dsh-tally`](../tally/README.md) 的参考界面插件，运行在 dsh 的 Web 界面（`dsh --profile web`）里。它只通过同源的 Remote API 命名空间 `tally` 读取 `dsh-tally` 的数据，自己不读凭据、不发起其他网络请求。

当前版本只包含一个状态点：在会话标题栏右侧显示一个小圆点，`tally/status` 调用成功时为绿色，失败时为红色，鼠标悬停可以看到说明。后续版本会把它换成正式的费用显示。

## 安装

先安装 `dsh-tally`，再安装本插件，然后重启 dsh：

```sh
dsh plugin --profile web add dsh-tally dsh-tally-ui
```

浏览器端代码只在 dsh 启动时加载，所以安装或升级后需要重启 dsh。

## 构建说明

`pnpm run build`（仓库根目录）依次执行：

1. `tsc -p .`：编译 Host 端入口 `src/index.ts` 到 `lib/index.js`。Host 端只声明插件名，`apply` 为空。
2. `tsc -p tsconfig.client.json`：只生成浏览器端代码的类型声明，输出到 `lib/types`。
3. `tsdown`：把 `src/client/index.ts` 打包成 `lib/client.js`。配置照搬 dsh 官方 `packages/client/tsdown.client.ts` 里的 `clientConfig()`：
   - 格式为 `cjs`，平台为 `browser`，输出文件名固定为 `client.js`，带 sourcemap；
   - 用 banner 和 footer 把整个模块包成 `window.__ModuleLoader__.load({ id: 'dsh-tally-ui', factory: (require) => { … } })`，由 dsh 的客户端模块加载器在需要时执行；
   - 只有宿主共享模块表里的模块保持为 `require()`：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`（tsdown 0.23 的 `deps.neverBundle`，即旧的 `external`）。其余全部内联，包括 zod、`dsh-tally/remote` 和本包自己的代码、样式。
4. `node scripts/check-client-bundle.mjs packages/tally-ui/lib/client.js`：扫描 bundle 里所有 `require("…")`，出现共享模块表以外的模块就报错退出。

**样式**：采用“factory 执行时注入 `<style>`”的方式，不使用 `.module.css`。`src/client` 下的 `.css` 文件在打包时被转换成一段代码，factory 执行时向 `document.head` 插入一个 `<style data-plugin="dsh-tally-ui" data-plugin-css="dsh-tally-ui/<文件名>">`（与 dsh 官方插件的标记相同，插件卸载时由 dsh 回收）。类名不做哈希，统一加 `dsh-tally-` 前缀避免冲突。样式只使用 `--dsw-alias-*` 语义变量，不写主题选择器和字面颜色值。

**接口描述**：浏览器端调用 Remote API 需要一份带严格编解码器的接口描述（`TypertRemoteContribution`）。dsh 官方用构建期生成器产出这份描述，但生成器依赖 dsh 仓库内部的工作区结构，所以由 `dsh-tally` 手写（`dsh-tally/remote`，见 `packages/tally/src/remote/contract.ts`），本包在启动时用 `ctx.remote.$mount()` 挂载。

**执行中的判断规则**：两条备用方案都没有用到。

- Host 端：编译后的 `lib` 里，标注了 `@Remote` 的方法能被 dsh 网关直接识别（网关从运行中的服务读取装饰器标记，参数名从编译后的函数读取），不需要改用 `bindTypertRemote` 手动注册。
- 浏览器端：手写的接口描述可以被 `ctx.remote.$mount()` 接受，不需要改用官方生成器 `typertPlugin`。

## 许可证

MIT
