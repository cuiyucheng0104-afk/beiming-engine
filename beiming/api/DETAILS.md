# 细则：薄壳与镜头帧缓存

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
- 图片：`artifacts` 的响应按 `content-type` 和产物名的扩展名认 PNG、JPEG、WebP、GIF（看解码后的产物名，不看请求地址的末尾；工作区产物名可以带 `#`，薄壳在地址里写成 `%23`，`contact#2.png` 照认；带 `?` 的名字过不了工作区的跨平台路径规则，服务端回 HTTP 422 `contract.bad-path`，薄壳原样交回），回一条摘要文本和一条 `{ type: "image", data, mimeType }`。成功信封里指向图片产物的引用（联系表、切点条带、交付的 `contact.png`）用同一个令牌取回，接在信封文本后面，不限张数和单张大小，按出现的顺序，同一张只取一次。引用从顶层 `outputs` 和 `data.sheet`、`data.strips`、`data.outputs` 里找，写成路径（`/v1/films/{id}/artifacts/…`）、本服务的完整地址、带 `url` 的对象或它们的数组都认；信封被截短时先读 `outputs` 里的全文；全文取不回来（404、断流、不是 JSON、不是本片的产物地址，或者 HTTP 200 回来的不是成功信封：普通对象、失败信封、过不了正式 `envelope/0.1` 契约校验的对象，比如只带 `ok:true`、`ok` 和 `exitCode` 对不上）时多一条 `{ url, fullOutputError }`，`isError` 为 `true`，截短的信封照样交回。某一张图取不回来不改动词的结果，在它的位置留一条 `{ url, error }`，后面的图照取。
- 取图的边界：只取本服务、这部片的产物；产物地址的样子从合同里 `artifacts` 的路径模板推出，服务端签发的产物引用和截短信封的全文引用也从同一个模板推出，改合同路径两头一起变。`{name}` 是模板末段时产物名逐段转义、`/` 留着；后面还有固定路径段时（如 `…/{name}/download`）整个产物名转义成一段（`sheets%2Frev1-draft%2Fcontact.png`），和服务端路由器的匹配规则一致。两个薄壳发出的请求都带令牌，一律 `redirect: 'error'`：服务回 3xx 按连不上处理（`env.missing-tool`），不跟过去。别的服务的地址、别的片的产物、带 `..` 的路径都跳过。片号取工作区动词的 `id` 或记下的作业归属；都没有时（重启后直接查作业）认第一个引用的那部片。
- JSON 和文本产物回正文，其他二进制回 `{ binary: true, url, bytes, sha256, mimeType }`。图片没有大小上限，很大的原件用命令行薄壳的 `--out` 落盘更合适。

## 程序接口

`index.mjs` 导出 `buildMcpTools(routes)`、`createMcpSession({ baseUrl, token, workspaceTokens, fetchImpl, routes })`、`serveMcpStdio(选项)`、`buildCliCommands(routes)`、`exitCodeForEnvelope(信封)`、`runApiCli(argv, { env, fetchImpl, stdout, routes })`。`routes` 默认是合同的 `ROUTES`，测试可以传加了动词的表。

改动后运行 `node --test beiming/api/shells.test.mjs`。

## 镜头帧缓存（A16）

`render`、`verify` 的补渲和 `deliver` 的终渲都经 `pipeline.mjs` 的 `renderPlan`。每部片的缓存在工作区 `deliver/.shot-cache/`（`jobs/cache.mjs` 的 `openShotCache`）：不进修订快照，跨修订、跨作业复用。每帧先按 04 §10 的六项键查缓存，命中的帧把 `color.f32`、`objectId.u32` 还原到 `<作业>/frames/<镜头>/layers/cache-f<局部帧号>/`，不调帧源；一个镜头全部命中就不为它起 Blender 或浏览器会话。只改 `s02` 再交付，`s01` 的渲帧数是 0。

`buildShotCacheInputs({ film, lock, shot, filmDir, tier, events, device })` 交出一个镜头的键输入：

| 项 | 进键的内容 |
|---|---|
| ① 镜头 | 镜头条目和它的起始帧；本镜头看得到的事件：落在镜头里的、`shot` 点名这个镜头的、镜头条目或入口文件里按名字引用的；片级参数 `output.fps`、`style.tokens`、`assets` 表、贴在这个镜头的 `overlays`、锁里的镜头种子 |
| ② 文件 | 入口文件，加上 `shots/` 下不是别的镜头入口的源码（共用模块）；用到的资产在锁里的摘要。`cards-data` 镜头没有入口 |
| ③ 轨道 | 镜头 `tracks` 声明的摘要，没有写 `'none'` |
| ④ 卡 | 镜头的卡、叠加层卡和数据层（`impl` 含 `data`）的卡在锁里的 `version` 与 `sha256`。合成的卡不进键：缓存存的是合成之前的层 |
| ⑤ 环境 | 帧源与宿主、锁里的运行时版本与镜像、浏览器可执行文件的指纹、浏览器的显卡参数、系统版本，加上帧源上次出帧时报的 `backend` 与 `gpu` |
| ⑥ 规格 | 档位、采样数、`output.size`、局部帧号、快门子帧相位 |

- **别的镜头改参数、改事件不影响本镜头；镜头整体后移要重渲**：起始帧在键里。镜头代码和卡拿得到 `ctx.shot.in`（[镜头契约](../kernel/contracts/shot/CONTRACT.md) S10，`time.timeline` 用它算全片时间），`time` 类型的卡参数写整数是全片帧号（转台模板片名卡的 `enter: 0`），后移之后同一个局部帧号的画面可以不一样。前一个镜头改长，后面的镜头都重渲；只改长最后一个镜头，前面的照常命中。`jobs/cache.mjs` 的键本身不含起始帧，由这里放进 `film.at`。
- 命中的元数据 `timing` 记 0，其余原样，`hash.color` 与还原出的颜色层一致。
- **读回校验**：文件头、颜色层、编号层各验 SHA-256，层的字节数要对上 `meta.size`，`meta.hash.color` 要对上颜色层。任一项不对就丢掉这一帧重渲。没带编号层的条目不当命中。
- **环境记录**：显卡后端和型号要帧源出过帧才知道，记在 `deliver/.shot-cache/devices.json`。全部命中的镜头照记录算键。真渲的帧报的不一样时改记录，这个镜头照旧环境查到的命中作废，照新环境整镜重渲。局限：换了显卡或驱动而系统版本没变时，全部命中的镜头发现不了，等到任一个同帧源的镜头真渲一帧才纠正；要立刻生效就删掉 `deliver/.shot-cache/`。
- **接缝检查**：容差档帧源（`blender`）出的一段连续帧里混了几轮的帧时跑 `checkCacheSeams`。有尖峰就 `invalidateShot`，旧帧在同一个会话里重渲，结果里这个镜头带 `seam: 'rerendered'`。抽样帧不连续，不查。
- **记账**：作业结论的 `data.renderedFrames`、`data.cachedFrames`、`data.shots[]`，账本行的 `frames`（等于 `renderedFrames`）与 `cachedFrames`。`frames` 和 `gpuSeconds` 只数真调了帧源的帧；交付另带 `deliveredFrames`。
- **L2 纯函数门不走缓存**：交付时每个镜头仍用 CPU 草稿档探两帧，它的耗时进 `gpuSeconds`、不进 `frames`。缓存的前提是「帧只由六项决定」，这道门守的就是这个前提，所以不缓存它的结论。
- **保留**：交付成功后 `prune()`：终稿每个镜头只留最近用过的一版，放了七天的条目清掉。草稿档的帧也进缓存，七天后清。
- **键算不出来**（镜头条目里有帧源才判得出的错）时这个镜头不走缓存，帧源照常出帧或报它自己的错。
- 测「重新渲染」（重复性、重建）时每次用新片子，或先删 `deliver/.shot-cache/`，否则测到的是命中。`renderPlan` 不传 `cache` 就每帧都渲。

改动后运行 `node --test beiming/api/shot-cache-api.test.mjs`：前半用记数的假帧源（只要 FFmpeg），最后一条用真 Blender 和无头浏览器交付两次，缺工具时跳过。
