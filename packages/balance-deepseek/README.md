# dsh-tally-balance-deepseek

给 [`dsh-tally`](../tally/README.md) 提供 DeepSeek 余额的插件：把两个余额查询函数注册到 `ctx.tallyBalance`。`dsh-tally` 本身不读凭据、不发网络请求，这两件事只在本包里发生。

## 为什么会被标红

dsh-trust-check 之类按能力扫描代码的工具会把本包标红，原因是它确实同时做了两件敏感的事：

- **读取凭据**：通过官方 `credentials` 服务读取保存 API key 的凭据（默认 `DEEPSEEK_API_KEY`）。
- **发起网络请求**：用 API key 请求 DeepSeek 的余额接口。

这是查询余额必须做的事，不是疏漏。为了方便审阅，本包把代码压得很小：

| 文件 | 行数（约） | 内容 |
| --- | --- | --- |
| `src/fetchers.ts` | 70 | 两个查询函数，凭据和网络请求都在这里 |
| `src/index.ts` | 60 | 插件入口，把查询函数注册到 `tallyBalance` |
| `src/parse.ts` | 150 | 纯函数，只解析 JSON、做十进制加法，不读凭据也不联网 |

合计约 280 行，全部可以在几分钟内读完。

## 只访问哪个域名

- **API key 路由**（`deepseek-official`）只请求 `GET {baseURL}/user/balance`。`baseURL` 默认是 `https://api.deepseek.com`，也就是只访问 `api.deepseek.com`；只有你自己改了 `baseURL`，才会访问别的地址。请求只带 `Authorization` 和 `Accept` 两个头。
- **账号路由**（`deepseek-account`）不自己发请求，而是调用官方 `deepseekAccount` 服务的 `getBalance`，登录态和请求都由官方服务管理。
- 除此之外没有任何其他网络访问，也不写任何文件。

## API key 不会泄露

API key 只会出现在发往 `baseURL` 的请求头里。任何错误信息都是固定文本（例如 `DeepSeek balance: HTTP 401`），不会包含 key；底层网络错误和 JSON 解析错误的原文也不会转发。key 不会写入日志，也不会进入余额快照。每次查询都会重新读取凭据，所以改了 key 不需要重启。

## 安装

```sh
dsh plugin --profile web add dsh-tally dsh-tally-balance-deepseek
```

插件依赖 `tallyBalance` 服务（由 `dsh-tally` 提供）。`credentials` 服务不在时不注册 API key 路由，`deepseekAccount` 服务不在时不注册账号路由；服务消失时对应路由会自动注销。

## 配置项

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `baseURL` | `https://api.deepseek.com` | DeepSeek API 地址。 |
| `apiKeyRef` | `DEEPSEEK_API_KEY` | 保存 API key 的凭据名（环境变量名）。 |
| `officialRoute` | `deepseek-official` | 用 API key 查询余额时注册的路由 id。 |
| `accountRoute` | `deepseek-account` | 用登录账号查询余额时注册的路由 id。 |

## 返回的钱包

每种币种（CNY、USD）返回三个钱包：`topup`（充值余额）、`granted`（赠送余额）和 `total`（合计）。账号路由的 `topup` 是官方账号余额之和，`granted` 是赠送余额之和，`total` 是两者之和。其他币种的条目被忽略。

## 查询失败

查询失败时不会显示 0：`dsh-tally` 返回上一次成功的快照并标记 `stale: true`，从未成功过则返回空的 `wallets` 并附带 `error`。常见的错误信息：

| 错误信息 | 含义 |
| --- | --- |
| `DEEPSEEK_API_KEY not configured` | 凭据服务里找不到 API key。 |
| `DeepSeek balance: HTTP 401` | 接口返回非 2xx（状态码随实际情况）。 |
| `DeepSeek balance: request failed` | 网络错误。 |
| `DeepSeek balance: invalid JSON response` | 响应不是 JSON。 |
| `DeepSeek balance: unexpected response shape` | 响应的结构不符合预期。 |
| `DeepSeek account: signed out` | 官方账号未登录。 |
| `DeepSeek account: balance query failed` | 官方账号服务查询余额失败。 |
