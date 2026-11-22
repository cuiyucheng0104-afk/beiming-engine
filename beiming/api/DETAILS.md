# 薄壳细则

命令行薄壳（`cli-shell.mjs`）和 MCP 薄壳（`mcp.mjs`）共用 `client.mjs`。三个文件都只读合同 `ROUTES`，不抄路由；合同增删改动词后，工具表、命令表、选项和请求跟着变。旧的 `tools/film` 命令不受影响。

## 入参表

每个动词的入参是一张平表，由路由推出：

| 来源 | 入参名 | 说明 |
|---|---|---|
| `route.params` | 参数原名（`id`、`name`、`path`） | 必填。整段按 URL 转义，带 `/` 的产物路径可以直接写 |
| `route.query` | 查询名（`wait`、`applyFixes`、`path`） | `requiredQuery` 里的必填。与路径参数或 `body` 重名时改叫 `query-<名>` |
| `route.request` | `body` | 请求体；`bodyRequired` 时必填 |

薄壳只判拼请求要用的部分：多余的入参、缺的必填、路径参数的类型。请求体的内容原样交给服务端按同一份合同判，这样 `film-put` 的诊断和修法不会被薄壳挡掉。

## 命令行

```sh
node beiming/api/cli.mjs <动词> [--选项 值] [--url <服务地址>] [--token <令牌>]
```

- 动词写在它自己的选项前面。`--list-verbs` 列全部动词，`<动词> --help` 列这个动词的选项。
- 请求体只能给一个来源：`--json <JSON>`、`--body-file <文件>`，请求体是文本的动词（`film-files`）用 `--text <文字>`。
- 请求体里有 base64 字段的动词（`film-assets`）多一个 `--file <文件>`：读文件、转 base64、填进那个字段，没给 `name` 就用文件名。
- 回文件字节的动词（`artifacts`）多一个 `--out <路径>`：先写临时文件再改名，标准输出回 `{ out, bytes, sha256, mimeType }` 的成功信封；请求失败时不写文件。不给 `--out`，字节原样写到标准输出。
- 薄壳自己判出的错误也是一行信封：用法错误是 `usage.bad-argument`（退出码 2），连不上服务或对面回的不是信封是 `env.missing-tool`（退出码 3）。
- 退出码查冻结的[错误码表](../kernel/contracts/errors/CONTRACT.md) 5.1 的前缀。前缀没登记时用信封自带的 `exitCode`，再没有就是 1。
- `issue-token` 和 `serve` 的选项与行为不变。

## MCP

```json
{ "mcpServers": { "beiming": { "command": "node", "args": ["beiming/api/cli.mjs", "mcp", "--url", "http://127.0.0.1:8080", "--token", "<账户令牌>"] } } }
```

- 传输是 stdio 上每行一条 JSON-RPC 2.0 消息。支持 `initialize`、`ping`、`tools/list`、`tools/call`，通知不回。协议版本认 `2025-11-25`、`2025-06-18`、`2025-03-26`、`2024-11-05`，别的版本回最新的那个。
- 工具名就是动词名，`inputSchema` 是上面的入参表，外加可选的 `_token`（只换这一次调用的令牌，不进请求）。
- JSON-RPC 错误：读不出的行 `-32700`，不是请求 `-32600`，没有的方法 `-32601`，没有的工具或入参表不合 `-32602`。服务端回的失败信封不是协议错误：`tools/call` 照常回结果，`isError` 为 `true`，正文是完整信封。
- 令牌选择：账户动词用启动时的令牌。工作区动词用这部片的工作区令牌，作业动词用作业所属那部片的。建片成功后记下 `data.film` 对 `data.token`，工作区动词回了 `data.job` 就记下作业归属。没记到的用启动时的令牌，所以也可以直接拿一部片的工作区令牌启动。记录只在进程里，重启后用 `_token`。
- 图片：`artifacts` 的响应按 `content-type` 和扩展名认 PNG、JPEG、WebP、GIF，回一条摘要文本和一条 `{ type: "image", data, mimeType }`。成功信封的 `outputs` 里指向图片产物的项（联系表、切点条带、交付的 `contact.png`）用同一个令牌取回，接在信封文本后面；信封被截短时先读 `outputs` 里的全文。图取不回来不改动词的结果，原因写在一条文本里。
- 上限：单张图超过 5 MiB 只回摘要，一个信封最多带回 8 张图。JSON 和文本产物回正文，其他二进制回 `{ binary: true, url, bytes, sha256, mimeType }`。

## 程序接口

`index.mjs` 导出 `buildMcpTools(routes)`、`createMcpSession({ baseUrl, token, workspaceTokens, fetchImpl, routes })`、`serveMcpStdio(选项)`、`buildCliCommands(routes)`、`exitCodeForEnvelope(信封)`、`runApiCli(argv, { env, fetchImpl, stdout, routes })`。`routes` 默认是合同的 `ROUTES`，测试可以传加了动词的表。

改动后运行 `node --test beiming/api/shells.test.mjs`。
