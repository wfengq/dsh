# 从源码安装

这里讲从本仓库的源码构建，再安装进你自己的 dsh，适合参与开发或想用 main 上最新改动的情况。只想使用的话，直接从 npm 安装预览版即可，见 [README](../README.md#安装)。

**桌面客户端和 `dsh web` 都能用。** 官方桌面客户端是在完整的 dsh Web 应用外面套了一层 Electron 壳，界面插件（`dsh-tally-ui`）看到的是同一套 Web 界面，所以费用条、看板、设置页在两边是一样的。区别只在安装命令的 profile 名：桌面客户端用 `desktop`，`dsh web` 用 `web`。

两种方式都实际跑通过：web 端在一个空的 `DSH_HOME` 上安装，再用独立安装的 dsh `0.2.0-rc.2` 和 `0.2.1-alpha.2` 分别跑过界面端到端测试；桌面客户端的步骤在 Windows 桌面客户端上装过并日常使用。

## 前提

- Node.js 22 以上，pnpm 10（`corepack enable` 会按仓库里 `packageManager` 字段指定的版本启用）。
- dsh 0.2.x（桌面客户端看“关于 DeepSeek Harness”里的版本）。CI 每天在 `0.2.0-rc.2`（latest）和 `0.2.1-alpha.2`（alpha）两个版本上测试。用 `dsh --version` 查看你的版本；如果不是 0.2.x，就用仓库自带的 dsh，把下文的 `dsh` 换成 `pnpm exec dsh`（需要在仓库目录下运行）。
- 用于查余额的 DeepSeek API key。默认读取名为 `DEEPSEEK_API_KEY` 的凭据，和官方 DeepSeek 适配器用的是同一个；你已经能在 dsh 里正常用 DeepSeek，就不需要再额外配置。

## 1. 获取并构建

```sh
git clone https://github.com/wfengq/dsh.git dsh-tally
cd dsh-tally
pnpm install
pnpm run build
```

`pnpm run build` 会把每个包的产物输出到各自的 `lib/` 目录，并检查浏览器端的 bundle。

## 2a. 装进桌面客户端

1. 先打开一次桌面客户端，让它初始化自己的 profile，然后**完全退出**（macOS 用 ⌘Q；Windows 用菜单“应用 → 退出”，只关窗口不算退出）。
2. 如果还没有注册 `dsh` 命令：在桌面客户端菜单里选 **管理 dsh 命令… → 安装**，然后打开一个新终端，运行 `dsh --version` 确认可用。桌面客户端的 profile 只能用它自带的这个 `dsh` 命令来管理，用 npm 装的 dsh 改不了它。
3. 在仓库根目录运行：

   macOS / Linux：

   ```sh
   dsh plugin --profile desktop add "$PWD/packages/tally"
   dsh plugin --profile desktop add "$PWD/packages/balance-deepseek"
   dsh plugin --profile desktop add "$PWD/packages/tally-ui"
   ```

   Windows（PowerShell）：

   ```powershell
   dsh plugin --profile desktop add "$PWD\packages\tally"
   dsh plugin --profile desktop add "$PWD\packages\balance-deepseek"
   dsh plugin --profile desktop add "$PWD\packages\tally-ui"
   ```

4. 重新打开桌面客户端。

确认安装成功：`dsh plugin --profile desktop list` 里应当有 `dsh-tally`、`dsh-tally-balance-deepseek`、`dsh-tally-ui` 三个包；客户端的“插件”页面里也能看到它们。

## 2b. 装进 `dsh web`（或终端、headless）

在仓库根目录运行：

```sh
dsh plugin --profile web add "$PWD/packages/tally"
dsh plugin --profile web add "$PWD/packages/balance-deepseek"
dsh plugin --profile web add "$PWD/packages/tally-ui"
```

确认安装成功：

```sh
dsh --profile web --dump-config | grep -A1 "id: tally"
```

应当能看到 `tally`、`tally-balance-deepseek`、`tally-ui` 三行。

## 两种安装方式都要注意

- 必须用**绝对路径**，并按上面的顺序安装：`dsh-tally-ui` 依赖 `dsh-tally`。
- 安装方式是**链接**（profile 的 `package.json` 里会出现 `link:/…/packages/tally`），不是复制。所以仓库目录不能删除或移动；以后改了代码，只要重新 `pnpm run build`，再重启 dsh 或桌面客户端就能生效，不用重装。
- 只需要在终端或 headless 模式下记账时，只装 `packages/tally` 即可，profile 也可以换成 `tui` 或 `headless`。

## 3. 启动并查看

打开桌面客户端，或者运行 `dsh web` 后在浏览器打开页面，应该能看到：

- 输入框下方的费用条（今日费用、余额、预算进度）；
- 每轮回复末尾的本轮费用，以及会话标题栏里的会话累计；
- 右侧栏的“用量”标签页（按天、按模型、按会话的看板）；
- 设置里的 dsh-tally 页面，可以在这里设置预算、开关各个界面元素。

第一次启动时会把已有的会话日志补记进账本，所以历史会话也会出现在看板里。不过 2026-10-10 之前的请求会显示为“未定价”，因为还没有核实过的历史价格。

## 数据存放位置

| 文件 | 内容 |
|---|---|
| `$DSH_HOME/tally/tally.v1.sqlite` | 账本（可以随时删除，下次启动会从会话日志重建） |
| `$DSH_HOME/tally/budgets.json` | 预算设置和已触发的提醒 |

`DSH_HOME` 默认是 `~/.dsh`。

## 对账（可选）

```sh
node packages/tally/lib/cli.js reconcile --bill ./bill.csv --format csv
```

从 npm 安装的用户用 `npx dsh-tally@beta reconcile …`。完整选项用 `--help` 查看，说明见 [`packages/tally/README.md`](../packages/tally/README.md#对账)。

## 更新

插件是链接安装的，更新不用重装：

1. 完全退出桌面客户端（或停掉 `dsh web`）。
2. 在仓库目录运行：

   ```sh
   git checkout main
   git pull
   pnpm install
   pnpm run build
   ```

3. 重新打开桌面客户端（或重新运行 `dsh web`）。

## 卸载

```sh
# 桌面客户端（先完全退出客户端）
dsh plugin --profile desktop remove dsh-tally-ui dsh-tally-balance-deepseek dsh-tally
# dsh web
dsh plugin --profile web remove dsh-tally-ui dsh-tally-balance-deepseek dsh-tally
```

卸载后账本和预算文件仍然留在 `$DSH_HOME/tally/`，不需要的话手动删除。

## 遇到问题

- **安装时出现 peer 依赖版本不符的警告，或启动时插件加载失败**：多半是你的 dsh 不是 0.2.x，改用 `pnpm exec dsh`，见“前提”一节。
- **页面上没有出现任何 tally 元素**：确认 `pnpm run build` 成功了（`packages/tally-ui/lib/client.js` 存在），然后彻底重启 `dsh web` 或桌面客户端。
- **桌面客户端提示 profile 未初始化**：先打开一次桌面客户端再完全退出，然后重新运行安装命令。
- **桌面客户端装完插件后启动失败**：客户端会弹出恢复对话框，选“禁用第三方插件”即可恢复启动，然后把对话框里的错误信息发给我。
- **余额显示“查询失败”**：检查 `DEEPSEEK_API_KEY` 凭据是否已配置；余额插件只访问 `api.deepseek.com`。
