# 薄壳细则

命令行薄壳（`cli-shell.mjs`）和 MCP 薄壳（`mcp.mjs`）共用 `client.mjs`。三个文件都只读合同 `ROUTES`，不抄路由；合同增删改动词后，工具表、命令表、选项和请求跟着变。旧的 `tools/film` 命令不受影响。

## 入参表

每个动词的入参是一张平表，由路由推出：

| 来源 | 入参名 | 说明 |
|---|---|---|
| `route.params` | 参数原名（`id`、`name`、`path`） | 必填。整段按 URL 转义，带 `/` 的产物路径可以直接写 |
| `route.query` | 查询名（`wait`、`applyFixes`、`path`） | `requiredQuery` 里的必填。与路径参数或 `body` 重名时改叫 `query-<名>`。合同里结构是数组的按重复键发（`tags=a&tags=b`），命令行里重复给这个选项 |
| `route.request` | `body` | 请求体；`bodyRequired` 时必填 |

薄壳只判拼请求要用的部分：多余的入参、缺的必填、路径参数的类型。请求体的内容原样交给服务端按同一份合同判，这样 `film-put` 的诊断和修法不会被薄壳挡掉。

## 命令行

```sh
node beiming/api/cli.mjs <动词> [--选项 值] [--url <服务地址>] [--token <令牌>]
node beiming/api/cli.mjs films-create --json '{"template":"turntable"}'
node beiming/api/cli.mjs render --id f_001 --wait 30 --json '{"tier":"draft"}'
```

- 服务地址取 `--url` 或 `BEIMING_API_URL`（默认 `http://127.0.0.1:8080`），令牌取 `--token` 或 `BEIMING_API_TOKEN`。路径参数和查询参数是同名选项。
- 动词写在它自己的选项前面。`--list-verbs` 列全部动词，`<动词> --help` 列这个动词的选项。
- 请求体只能给一个来源：`--json <JSON>`、`--body-file <文件>`，请求体是文本的动词（`film-files`）用 `--text <文字>`。
- 请求体里有 base64 字段的动词（`film-assets`）多一个 `--file <文件>`：读文件、转 base64、填进那个字段，没给 `name` 就用文件名。
- 标准输出是一行信封。回文件字节的动词（`artifacts`）多一个 `--out <路径>`：先写临时文件再改名，标准输出回 `{ out, bytes, sha256, mimeType }` 的成功信封；请求失败时不写文件。不给 `--out`，标准输出是文件的原始字节，不是信封，不要交给 JSON 解析器。
- 薄壳自己判出的错误也是一行信封：用法错误是 `usage.bad-argument`（退出码 2）；连不上服务、对面回的不是信封、HTTP 状态不是 2xx 却回 `ok: true` 的信封，都是 `env.missing-tool`（退出码 3）。HTTP 状态不是 2xx 的失败信封原样交回，错误码和诊断不变。
- 退出码只查冻结的[错误码表](../kernel/contracts/errors/CONTRACT.md) 5.1 的前缀：`usage.` 2，`env.` 3，`contract.` 与 `auth.` 4，`busy.` 5，`timeout.` 124，`failure.` 1。前缀没登记的一律 1，信封自带的 `exitCode` 不用，所以退出码只有 0、1、2、3、4、5、124。
- `mcp` 只收 `--url` 和 `--token`：多余的参数或不认识的选项在标准错误打一行用法，退出码 2，不进 stdio 循环。
- `issue-token` 和 `serve` 的选项与行为不变。

## MCP

```json
{ "mcpServers": { "beiming": { "command": "node", "args": ["beiming/api/cli.mjs", "mcp", "--url", "http://127.0.0.1:8080", "--token", "<账户令牌>"] } } }
```

- 传输是 stdio 上每行一条 JSON-RPC 2.0 消息。支持 `initialize`、`ping`、`tools/list`、`tools/call`，通知不回。协议版本认 `2025-11-25`、`2025-06-18`、`2025-03-26`、`2024-11-05`，别的版本回最新的那个。
- 工具名就是动词名，`inputSchema` 是上面的入参表，外加可选的 `_token`（只换这一次调用的令牌，不进请求）。
- JSON-RPC 错误：读不出的行 `-32700`；不是请求（`jsonrpc` 不是 `"2.0"`、没有 `method`、`id` 不是字符串、数字或 `null`）`-32600`，不合规的 `id` 不回显；没有的方法 `-32601`；`params` 不是对象、没有的工具、入参表不合 `-32602`。`tools/call` 省略 `arguments` 当空对象，显式给 `null`、数组或原始值是 `-32602`，不调服务。服务端回的失败信封不是协议错误：`tools/call` 照常回结果，`isError` 为 `true`，正文是完整信封。
- 令牌选择：账户动词用启动时的令牌。工作区动词用这部片的工作区令牌，作业动词用作业所属那部片的。建片成功后记下 `data.film` 对 `data.token`；工作区动词回了 `data.job`，或建片（`mode=delegate`）同时回了作业号，就记下作业归属，紧接着的 `job-get` 用这部片的工作区令牌。没记到的用启动时的令牌，所以也可以直接拿一部片的工作区令牌启动。记录只在进程里，重启后用 `_token`。
- 图片：`artifacts` 的响应按 `content-type` 和产物名的扩展名认 PNG、JPEG、WebP、GIF（看解码后的产物名，不看请求地址的末尾），回一条摘要文本和一条 `{ type: "image", data, mimeType }`。成功信封里指向图片产物的引用（联系表、切点条带、交付的 `contact.png`）用同一个令牌取回，接在信封文本后面，不限张数和单张大小，按出现的顺序，同一张只取一次。引用从顶层 `outputs` 和 `data.sheet`、`data.strips`、`data.outputs` 里找，写成路径（`/v1/films/{id}/artifacts/…`）、本服务的完整地址、带 `url` 的对象或它们的数组都认；信封被截短时先读 `outputs` 里的全文；全文取不回来（404、断流、不是 JSON、不是本片的产物地址，或者 HTTP 200 回来的不是成功信封：普通对象、失败信封、过不了正式 `envelope/0.1` 契约校验的对象，比如只带 `ok:true`、`ok` 和 `exitCode` 对不上）时多一条 `{ url, fullOutputError }`，`isError` 为 `true`，截短的信封照样交回。某一张图取不回来不改动词的结果，在它的位置留一条 `{ url, error }`，后面的图照取。
- 取图的边界：只取本服务、这部片的产物；产物地址的样子从合同里 `artifacts` 的路径模板推出，服务端签发的产物引用和截短信封的全文引用也从同一个模板推出，改合同路径两头一起变。`{name}` 是模板末段时产物名逐段转义、`/` 留着；后面还有固定路径段时（如 `…/{name}/download`）整个产物名转义成一段（`sheets%2Frev1-draft%2Fcontact.png`），和服务端路由器的匹配规则一致。两个薄壳发出的请求都带令牌，一律 `redirect: 'error'`：服务回 3xx 按连不上处理（`env.missing-tool`），不跟过去。别的服务的地址、别的片的产物、带 `..` 的路径都跳过。片号取工作区动词的 `id` 或记下的作业归属；都没有时（重启后直接查作业）认第一个引用的那部片。
- JSON 和文本产物回正文，其他二进制回 `{ binary: true, url, bytes, sha256, mimeType }`。图片没有大小上限，很大的原件用命令行薄壳的 `--out` 落盘更合适。

## 程序接口

`index.mjs` 导出 `buildMcpTools(routes)`、`createMcpSession({ baseUrl, token, workspaceTokens, fetchImpl, routes })`、`serveMcpStdio(选项)`、`buildCliCommands(routes)`、`exitCodeForEnvelope(信封)`、`runApiCli(argv, { env, fetchImpl, stdout, routes })`。`routes` 默认是合同的 `ROUTES`，测试可以传加了动词的表。

改动后运行 `node --test beiming/api/shells.test.mjs`。
