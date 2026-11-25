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

`render`、`verify` 的补渲和 `deliver` 的终渲都经 `pipeline.mjs` 的 `renderPlan`。每部片的缓存在工作区 `deliver/.shot-cache/`（`jobs/cache.mjs` 的 `openShotCache`）：不进修订快照，跨修订、跨作业复用。每帧先按 04 §10 的六项键查缓存，命中的帧把 `color.f32`、`objectId.u32` 和别的请求层还原到 `<作业>/frames/<镜头>/layers/cache-f<局部帧号>/`，不调帧源；一个镜头全部命中就不为它起 Blender 或浏览器会话。只改 `s02` 再交付，`s01` 的帧源调用是 0 次（终渲和 L2 都算）；原样再交付，全片是 0 次。

`buildShotCacheInputs({ film, lock, shot, filmDir, tier, events, device, engineDigest, cardsDigest, engineRoot })` 交出一个镜头的键输入：

| 项 | 进键的内容 |
|---|---|
| ① 镜头 | 镜头条目和它的起始帧；完整全片事件表 `events.events`（`shotInput` 把全片事件交给镜头与卡，修改任意事件都会使受影响缓存键失效）；片级参数 `output.fps`、`style.tokens`、`assets` 表、贴在这个镜头的 `overlays`、锁里的镜头种子 |
| ② 文件 | 入口文件，加上 `shots/` 下不是别的镜头入口的源码（共用模块）；用到的资产在锁里的摘要。`cards-data` 镜头没有入口 |
| ③ 轨道 | 镜头 `tracks` 声明的摘要，没有写 `'none'` |
| ④ 卡 | 镜头的卡、叠加层卡和数据层（`impl` 含 `data`）的卡在锁里的 `version` 与 `sha256`。合成的卡不进键：缓存存的是合成之前的层 |
| ⑤ 环境 | 帧源与宿主、锁里的运行时版本与镜像加上按作业实时计算的引擎代码/字体摘要（`engineCodeDigest`）与本镜头所用卡的磁盘实时摘要（`liveCardsDigest`，仍保持 `jobs/cache.mjs` 的 5 个 `ENV_KEYS` 不变）、浏览器可执行文件的指纹、浏览器的显卡参数、系统版本、锁里声明的出片机器 `lock.machine`（`class`、`driver`，整个对象规范化后进键），加上帧源上次出帧时报的 `backend` 与 `gpu` |
| ⑥ 规格 | 档位、采样数、`output.size`、局部帧号、快门子帧相位、这一档要帧源交的层 `layersOf(film, tier)`。`colorRef` 在镜头条目里，属于 ① |

- **实时引擎/字体/卡摘要、进程内有效摘要与签锁/交付核对**：`runtime.mjs` 的 `engineCodeDigest(source, { root = REPO, effective = false } = {})` 按 POSIX 相对路径排序并同时哈希路径、长度与内容摘要（跳过 `*.test.*`、`*.md`、`out/`、`__pycache__/`、`.git/`、`node_modules/`）：共用涵盖 `beiming/kernel/eval/` 与 `routes/c-style/fonts/`（`fonts.json` 及目录内存在的 `.woff2`/`.ttf`/`.otf` 等字体文件），`three` 另含 `beiming/sources/three/` 与 `beiming/host/page/`，`blender` 另含 `beiming/sources/blender/`，其他合法帧源（含 `ext.<名>` 扩展帧源，拒绝 `..` 与路径分隔符）另含存在的 `beiming/sources/<source>/`。默认 `effective = false`（供签锁与外部 `root` 测试使用）全部文件实时读盘；`effective = true` 且 `root === REPO`（供本进程缓存键与交付核对使用）对每次作业现读磁盘的浏览器脚本、Blender Python、字体、扩展源实时读盘，对本进程启动时已静态导入的纯 Node ESM 模块改用启动期只读快照 `LOADED_IN_PROCESS_DIGESTS`，对 `three` 帧源中既被 Node 启动导入又被页面宿主按请求从磁盘读给浏览器的双端加载模块（`sources/three/{caps.mjs,plan.mjs,source.js}` 与 `kernel/eval/*.mjs`）在未改盘时与磁盘摘要严格一致、热改盘后同时纳入现读磁盘字节与 `#in-process` 启动快照（立即使旧缓存与旧交付锁失效并隔离重启后的新版缓存键），杜绝热进程旧内存代码污染新版缓存键或旧锁误放行。`liveCardsDigest(cardIds, { root })` 按次实时哈希本镜头所用卡（含 `film.overlays` 隐式引用的 `two-d.overlay`）与数据层卡的非测试运行时文件。`threeImage(opts)` 与 `blenderImage(version, opts)` 合入 `engineCodeDigest` 与既有上游构建/版本；`server.mjs` 的 `commit()` 与传给 `createWork` 的动态卡库读取器每次作业实时调用 `loadCardLibrary()`；`work.mjs` 的 `deliver` 在封包前核对片子用到的各帧源 `lock.sources[s].image` 与当前有效环境镜像（`threeImage({ effective: true })` / `blenderImage(ver, { effective: true })`），不一致直接抛 `env.lock-required` 拒绝为新版像素附旧锁。
- **别的镜头改参数不影响本镜头；全片事件变更失效全片；镜头整体后移要重渲**：起始帧在键里。镜头代码和卡拿得到 `ctx.shot.in`（[镜头契约](../kernel/contracts/shot/CONTRACT.md) S10，`time.timeline` 用它算全片时间），`time` 类型的卡参数写整数是全片帧号（转台模板片名卡的 `enter: 0`），后移之后同一个局部帧号的画面可以不一样。前一个镜头改长，后面的镜头都重渲；只改长最后一个镜头，前面的照常命中。`jobs/cache.mjs` 的键本身不含起始帧，由这里放进 `film.at`。因为 `shotInput` 传入全片事件表，`events` 按完整 `events.events` 进键，修改任意事件都会令全片各镜头键失效。
- 命中的元数据 `timing` 记 0，其余原样，`hash.color` 与还原出的颜色层一致。
- **命中的帧身份**。写缓存时，管线在元数据的 `cache` 字段记录帧键和各层的 SHA-256。恢复时核对帧键、层摘要和 `meta/0.1` 的 `shot`、`frame`、`shotFrame`、`source.id`、`source.tier`。`size` 必须逐轴匹配当前帧源的 `planRender` 结果，颜色和辅助层的长度也按这个画幅检查。例如 `320 × 180` 影片默认生成 `160 × 90` 的草稿帧，校验也遵循镜头的 `tiers.<档位>.scale`。错画幅、错帧号或旧版本的载荷，以及被替换的辅助层，都会触发该帧重新渲染并覆盖缓存。升级前缺少 `cache` 字段的帧首次读取时重渲一次。输出的元数据只带帧源字段。缓存目录假定由管线写入，能同时改写载荷、帧键及摘要的写入者也能生成自洽记录。
- **请求的通道**：`film.delivery.layers` 是终渲要落盘的通道。终渲档向帧源要 `color`、`objectId` 加上它点名的通道（`depth`、`normal`），草稿档只要前两个。这组层名进键，所以换一组通道必重渲，不会拿缺层的旧帧当命中。层文件 `depth.f32`、`normal.f32` 和颜色层放在同一个目录；`<镜头>/exr/l<局部帧号>.exr` 一律由管线用 `verify/exr` 的写入器写（ZIPS，32 位），`readExr` 读得回来（FFmpeg 的 EXR 编码器不写 `pixelAspectRatio`，以前没点名通道时由它写的文件 `readExr` 读不了）。通道是 `R`、`G`、`B`、`A` 加 `depth.Z`、`normal.X`、`normal.Y`、`normal.Z`、`objectId.id`（点名了哪个带哪个），数就是层文件里的；没点名时只有颜色。帧源交不出的通道（`motion`、降噪层、分灯组）由帧源报 `contract.unsupported-output`，作业失败，不出缺层的帧。场景参考通路里页面帧源另交的 `frame.exr`、`objectId2x.u32` 也随帧进缓存、原样还原；页面帧源的场景参考镜头（`source: three`、`colorRef: scene`）命中时这两个文件必须都在，`objectId2x.u32` 的大小必须是 2 倍画幅，`frame.exr` 要用 `readExr` 整个解得开、宽高是这一帧的画幅，页面宿主该写的通道一个不缺、每个都是宽乘高个样本：浮点的 `color.R`、`color.G`、`color.B`、`color.A`，这一帧向帧源要的每个辅助通道的每个分量（浮点的 `depth.Z`、`normal.X`、`normal.Y`、`normal.Z`，整数的 `objectId.id`），要了编号层另有浮点的 `objectId2x.coverage`（缓存的校验和只保证存进去的字节没变，不保证存的是个好文件；独立的 `normal.f32` 在也不说明原生 EXR 里的 `normal.Z` 在），辅助通道的数还要和层文件里的逐样本相同（页面宿主写这个文件时用的就是层文件里的数，对不上就是别的帧的文件），否则这一帧当没命中重渲，还原出的帧目录每帧都有解得开的 `frame.exr`。成片（`master.mp4`、`web.mp4`）只用颜色。
- **读回校验**：文件头、颜色层和每个辅助层各验 SHA-256，层的字节数要对上 `meta.size`，`meta.hash.color` 要对上颜色层，这一档要的层一层不能缺。任一项不对就丢掉这一帧重渲。
- **环境记录**：显卡后端和型号要帧源出过帧才知道，记在 `deliver/.shot-cache/devices.json`。全部命中的镜头照记录算键。真渲的帧报的不一样时改记录，这个镜头照旧环境查到的命中作废，照新环境整镜重渲。锁里的 `machine.driver`、`machine.class` 改了立刻换键。局限：实际换了显卡或驱动、锁和系统版本都没变时，全部命中的镜头发现不了，等到任一个同帧源的镜头真渲一帧才纠正；要立刻生效就删掉 `deliver/.shot-cache/`。
- **接缝检查**：容差档帧源（`blender`）出的一段连续帧里混了几轮的帧时跑 `checkCacheSeams`。有尖峰就 `invalidateShot`，旧帧在同一个会话里重渲，结果里这个镜头带 `seam: 'rerendered'`。抽样帧不连续，不查。
- **记账**：作业结论的 `data.renderedFrames`、`data.cachedFrames`、`data.shots[]`，账本行的 `frames`（等于 `renderedFrames`）与 `cachedFrames`。`frames` 只数终渲、补渲里真调了帧源的帧；`gpuSeconds` 是帧源 `render` 调用的耗时之和，真跑了的 L2 探针也在里面；交付另带 `deliveredFrames`。账本行和 `outcome.json` 的 `sourceRenders` 是 `{ 镜头: 次数 }`：帧源池里数的这个作业对每个镜头调了几次 `session.render`（终渲、补渲、L2 探针都算），一次没调的镜头不出现。全部命中的交付是 `{}`，`gpuSeconds` 是 0。
- **L2 纯函数门的结论按镜头的版本记**：交付时每个镜头用 CPU 草稿档探两帧、三种次序（6 次 `render`）。过了门就在缓存里这一版镜头（除帧号外的全部键，`shotKey`）的目录下记一条带校验的记录（`putShotVerification`），连同 `framesColorDigest`：这个镜头全部帧的颜色摘要按帧序连起来的摘要。下次交付，一个镜头这一轮全部命中、这一版有过门的记录、记录认的帧就是这一轮交出的帧时照记录用，`layers.L2.gates[]` 里这一项带 `cached: true`，不起帧源。这一轮有真渲的帧（改过、坏帧补渲、接缝重渲）、没有记录、记录坏了、帧换过（别的作业补过不逐位相同的帧）就真跑，开跑前先把旧记录盖成未过，门跑到一半作业被取消也不留能复用的旧记录。**镜头没过 L2**：纯函数门没过（含探针出帧报错），或者它有帧的包围盒核对没过（IoU < 0.95、编号层上有没登记的编号等；包围盒先核，失败项按帧号归到镜头，归不到的算在每个镜头头上）。这一版镜头的帧和记录当场一起作废（`invalidateShot`），下一次交付整镜重渲、重新过门，不会拿更早的过门记录交付，也不会每次都还原同一张坏帧；纯函数门过了、包围盒没过的镜头不记过门记录，门照记录用（`cached: true`）的镜头有帧包围盒没过也一样作废。读结论看 `layers.L2.ok`：`gates[].cached` 只说纯函数门这一项，可以和 `bbox.ok: false` 同时出现。六项里任一项变了是新的一版，没有记录。单独的 `POST verify` 每次真跑，不读记录、过了也不记；帧索引 `frames-<tier>.json` 无损保存每条缓存记录产出时的轻量 `cacheEntry`（`{ tier, shotId, shotKey }`），包围盒检查失败时按失败帧携带的 `cacheEntry` 精准作废对应缓存版本（不误伤同镜头其他版本好帧，草稿抽样发现当前版本自身坏帧时同步作废当前终渲档，旧索引无 `cacheEntry` 时回退当前键），纯函数门失败时作废当前版本键；没点名过门的镜头有帧包围盒没过也同样精准作废。核验读的是帧索引，同一修订要等下一次渲染或交付把帧重渲了才会过。局限：帧源在同样的六项下偶尔才不确定时，过过一次门的镜头要等它下次有帧真渲才会再探。
- **保留**：交付成功后 `prune()`：终稿每个镜头只留最近用过的一版，放了七天的条目清掉。草稿档的帧也进缓存，七天后清。
- **键算不出来**（镜头条目里有帧源才判得出的错）时这个镜头不走缓存，帧源照常出帧或报它自己的错。
- 测「重新渲染」（重复性、重建）时每次用新片子，或先删 `deliver/.shot-cache/`，否则测到的是命中。`renderPlan` 不传 `cache` 就每帧都渲。

改动后运行 `node --test beiming/api/cache-engine-digest.test.mjs beiming/api/shot-cache-api.test.mjs`：前者用临时引擎副本验证帧源代码、页面宿主、求值核、字体、卡实现、半途续渲不混帧、全片事件进键与同进程不重启重签锁；后者前半用记数的假帧源（只要 FFmpeg），最后两条用真 Blender 和无头浏览器：一条经 HTTP 把双镜头片交付二十来次（改一个镜头、原样再交付、换三组 `delivery.layers`、把页面镜头改成场景参考，各冷热对照；从一帧的缓存条目里抽掉原生 `frame.exr`、把它截成前 16 字节、只去掉它里面的 `normal.Z`，看它只重渲这一帧补齐；往一帧的编号层点坏两个像素让包围盒不过，看交付和单独核验都报 422 并作废这一版，原样再交付重渲后 200），另一条用单镜头的场景参考页面片，把 288 × 200、180 × 320、同画幅另一帧和改片名之前那一版的整条真实载荷（还有只换原生 EXR 的）写进 320 × 180 一帧的键，看交付照样 200、只重渲这一帧，草稿档缩半的帧照常命中。帧源调用次数读账本行的 `sourceRenders`，缺工具时跳过。

## 委托三角色、镜头工五段任务书、服务端模板判定与 L5 三视角九票规程

`beiming/api/delegate-roles.mjs` 定义委托模式与 L5 审片的角色边界、任务书模板与投票聚合器，由 `index.mjs` 统一导出：

- **三角色配置（`DELEGATE_ROLES`）**：
  - `director`（导演）：读取 `GET /v1/guide`、服务端已判定的片子脚手架与检索到的技术卡（`POST /v1/cards/search`），先把需求转化为可核验的 `predicates.extra` 断言（严禁削弱 `predicates.base` 的 `floor@1` 底线），再排定镜头表与文案，用 `PUT /v1/films/{id}/film`（`patch/0.1` 带 `rev`）提交。
  - `shot-worker`（镜头工）：每个镜头启动全新独立会话（`freshSessionPerShot: true`），只允许修改本镜头 `shots/<shotId>/*` 的 `patch/0.1` 并执行草稿渲染与核验。起始上下文（`system` + 首条 `user` 任务书 + `HTTP_TOOL`）按 `measureStartContextTokens`（`ceil(utf8Bytes / 3.5)`）核验，硬上限 `SHOT_WORKER_MAX_START_TOKENS = 15,000`。
  - `reviewer`（异族视觉审片人）：执行 L5 三视角 × 3 票审片，输出只做参考（`overridesHardGates: false`）。
- **固定五段镜头工任务书（`buildShotWorkerBrief` / `buildShotWorkerMessages`）**：
  - 按顺序固定输出五段标题：`## 1. 镜头条目`（紧凑单行镜头 JSON、帧区间 `[in, out)`、当前 `rev` 与 `shots/<shotId>/` 路径边界）、`## 2. 基础谓词`（`floor@1` 展开项与导演追加的 `predicates.extra`）、`## 3. 可用的卡`（已绑卡实例与候选卡摘要）、`## 4. 预算`（可用 `tokens`、`gpuSeconds`、`wallSeconds`、`maxSteps`）、`## 5. 汇报格式`（状态、修订号、草稿渲染与核验摘要、遗留问题）。
  - 镜头条目先紧凑 JSON 序列化再按预算安全截断（不切出残缺 JSON）；`budget.tokens` 校验与 HTTP 契约一致（`0..1,200,000`）。当候选卡库或需求原文超长时，按三级确定性配置自动折叠非核心摘要，保证五段结构完整且起始上下文严格 `<= 15,000` token。委托编排器在镜头工首次未过触发重试前，会重新读取最新片子与镜头条目，使第二次任务书拿到最新 `rev` 与改动后的镜头 JSON；若最新修订已删除该镜头，则跳过该镜头并记入 `skippedRemovedShots`，不再回退旧镜头派工。
- **委托片服务端确定性模板判定（`selectDelegateTemplate({ brief, assets })`）**：
  - 零随机、零墙钟、零外部状态：当 `POST /v1/films` 指定 `mode: "delegate"` 且非考题片时，服务端忽略客户端传入的 `template`，按需求原文与资产引用确定性判出 `turntable` 或 `title` 及默认资产引用，并在工作区 `meta` 记录 `templateSelectedBy: "server"`（同时持久化单片 `budget` 供 L5 与交付查账）。
- **L5 三视角九票审片规程（`L5_PERSPECTIVES`、`L5_ISSUE_KEYS`、`L5_GRADES`、`normalizeIssueKey`、`aggregateL5Votes`、`filterL5SuggestedPredicates`）**：
  - 三个冻结视角：`composition-readability`（构图与可读）、`motion-rhythm`（动作与节奏）、`look-consistency`（质感与一致性），每个视角独立投 3 票，共 9 张选票；等级词固定为 `L5_GRADES = ['好', '一般', '差']`；每个视角冻结封闭 `L5_ISSUE_KEYS` 类别表，由 `normalizeIssueKey(rawKey, perspective)` 规范化并拒绝表外或跨视角键（如泛化键 `issue`）。
  - **每票前可执行上界、原子预留与异常零丢账**：`createOpenAiVisionReviewer` 每次视觉请求显式带上 `max_tokens`（默认 `DEFAULT_REVIEW_MAX_OUTPUT_TOKENS = 1,024`，不超过剩余预算），发票前按文本字节、PNG 图像尺寸、输出上限与已观测高水位计算可执行保守上界（首票绝不为 `0`），并通过 `work.mjs` 按 `filmId` 维护进程内原子预留租约（同片并发 `review` / `deliver` 共享预留并在响应或异常 `finally` 时用实耗替换释放，服务端 `review` 落账后才释放租约）；`chat()` 先提取 `usage` 再校验 `choices[0].message`（坏信封亦附带已提取 `usage` 照常累加并写带 `film` 的外部账本），`budgetCheck()` 抛错时停票并保留已投有效票、累计 `usage` 与 `stoppedReason: 'budget.check-error'`。
  - **有界并发投票、槽位保序与预算结算边界**：`createOpenAiVisionReviewer` 默认 `concurrency = DEFAULT_REVIEW_CONCURRENCY`（`1`，严格逐票高水位预算边界），`reviewerFromEnv` 支持 `BEIMING_REVIEW_CONCURRENCY` 环境变量覆盖（未设或纯空白回退默认 `1`，合法范围 `1..16`，非整数或越界抛 `usage.bad-argument`）。显式配置 `concurrency > 1` 或 `BEIMING_REVIEW_CONCURRENCY=3` 时，首票完成高水位标定后其余选票按 `concurrency` 并发加速，适用于同一批图像输入稳定、预算充裕的审片加速场景（若上游同图变价剧烈且预算紧贴高水位，应保持 `concurrency = 1`）。全部选票按固定 `slotIndex` 槽位落位后汇总 `ballots` 与 `invalidBallots`，乱序 HTTP 返回不改变结果顺序；逐票检查 `budgetCheck` 是否返回 `settle` 回调（缺 `settle` 时立即退回串行 `1` 且等待本票与既有在途票全部结算完毕再进入下一票检查；仅传有限 `maxTokens` 而无 `budgetCheck` 时自动保持串行 `1`）；在途预留暂满、因在途临时预留导致 `decision.maxOutputTokens` 被裁小（先释放该临时预留并等在途结算后重申，仅无在途预留时才按裁减后的 `max_tokens` 发出）或异步 `budgetCheck` 期间在途票已完成结算（`settledSeq` 推进）时自动等待/重检而不采纳过期拒绝；调度循环以 `try/finally` 排空全部在途票完成记账与结算后才返回或抛错，并以 `Object.hasOwn` 读取 `L5_ISSUE_KEYS`。
  - 含候选对比列表 `candidates` 时，`shuffleCandidatesForBallot` 按 `sha256(filmId:perspective:voteIndex:candidateId:idx)` 确定性打乱每票候选展示顺序，再汇总各候选等级词得票；拒绝重复 `(perspective, voteIndex)` 选票、候选目录重复 ID 与未知/重复候选评分。
  - 每条意见必须含合法全片帧区间 `frames: [start, end]`（`0 <= start <= end < totalFrames`）、严重度、非空证据 `evidence`、非空意见 `comment` 与本视角封闭 `issueKey`。按 `(perspective, issueKey, 重叠或相邻帧段)` 做输入顺序无关的连通分量聚类，**得票数 `>= 2`（`quorum: 2`）才成立进入 `opinions`**；1 票孤立意见计入 `discardedOpinionCount`，表外或缺失 `issueKey` 的意见计入 `rejectedOpinions`，逐票明细保留在 `ballots`。当 `opinions` 为空但存在 `discardedOpinionCount > 0` 或 `rejectedOpinions.length > 0` 时，总评保守封顶为 `一般`（不落回 `好`），平票按 `差 > 一般 > 好` 取保守一档。
  - 仅得票 `>= quorum` 的建议谓词经 `filterL5SuggestedPredicates` 逐条过 `checkExtra`、帧域/上下文作用域（无 `film` 时亦校验已知 `totalFrames` 并拒绝缺上下文的 `shot`/`event` 作用域）、`enforcePredicateFloor` 与与正式 `layerL1` 一致的考题基线分离 `checkL1`：通过 L1 的合法谓词记入 `suggestedPredicates` / `validatedExtraPredicates`（不会自动改写片子 `predicates.extra`），未登记谓词、越界帧域或削弱 `floor@1` 底线的建议谓词一律拦截在 `rejectedPredicates`。
  - 所有公开导出函数在解构入参前执行零陷阱纯数据校验（拒绝 Proxy、getter/setter 访问器、稀疏/附键数组、非纯对象原型、循环引用、越界数值等），统一抛出 `code: 'usage.bad-argument'`。
  - 改动后运行 `node --test beiming/api/l5-parallel.test.mjs beiming/api/a19-delegate-roles.test.mjs`。

## 做片代理视觉回看、原尺寸审片关键帧与报告顶层对齐

- **做片代理直接看渲染图（`agents.mjs`、`delegate.mjs`、`server.mjs`）**：
  - `server.mjs` 的二进制产物路由对 `.png`、`.jpg`/`.jpeg`、`.webp` 分别返回 `image/png`、`image/jpeg`、`image/webp`（`.json`/`.lock` 仍为 `application/json`，其余二进制仍为 `application/octet-stream`）。
  - `callApi()` 收到 HTTP 2xx 且 `content-type` 为 `image/png`、`image/jpeg` 或 `image/webp` 时按流读取字节并严守 `<= 8 MiB` 上限：满足 `0 < bytes <= 8 MiB` 时，返回的 `text` 带 `imageAttached: true` 且附 `image: { mimeType, base64, bytes, path }`；为空或超 8 MiB 时 `imageAttached: false`、不附加 `image` 且不在内存中缓冲超限载荷。
  - `runHandsOnAgent()` 与 `runDelegateOrchestrator()` 在整轮 `http_request` 的全部 `role: 'tool'` 消息落入会话后，立刻追加一条包含 `image_url`（`data:<mimeType>;base64,...`）的多模态 `role: 'user'` 消息（`buildToolImageMessage`），使视觉做片模型下一轮直接看到渲染帧与联系表；委托编排器同步以 `estimateChatBodyInputTokens` 按图像分辨率估算输入 token 上界，不把 base64 字符数当纯文本 token 误判超预算。
- **审片材料附未缩放原尺寸关键帧与需求原文逐级兜底（`pipeline.mjs`、`work.mjs`、`agents.mjs`、`server.mjs`）**：
  - `reviewKeyframeNumbers(film, maxCount)` 导出共用镜头中点选帧逻辑（多镜头时均匀上限 4 帧、去重升序）；`reviewMaterials({ master, fps, film, outDir })` 保留 `contact.png` 与切点条带，并从 `master` 按该目标帧号列表抽帧（不缩放，保持与 `film.output.size` 一致的原始分辨率）落盘到 `keyframes/keyframe-f<帧号>.png`，以 `{ name: 'keyframe-f<帧号>', path }` 加入 `images`。
  - 未交付前的 `material === 'frames'` 审片通过内部联系表/切点条带生成器将审片材料写入按次隔离的 `review/rev-<rev>/materials-<id>/` 目录（与 `POST /observe/sheet` 的 `sheets/` 及并发 `POST /review` 彻底隔离，`master` 模式审片同样按次隔离材料目录，且 `review.json` 经临时文件原子改名落盘）；原尺寸关键帧先按 `reviewKeyframeNumbers(film)` 检查当前修订 `frames-final.json` 中已存在且像素宽高严格等于 `film.output.size` 的目标中点帧（全部命中时零额外渲染）；对缺失或仅渲染了半尺寸的目标帧，基于审片专用浅拷贝 `reviewFilm`（剥离 `delivery.layers` 避免请求未实现交付通道、将镜头缩小的 `tiers.final.scale` 归一为 `1` 以保证原尺寸）以 `final` 档仅补渲这 1–4 帧到 `review/rev-<rev>/keyframes`（不改写 `frames-final.json` 索引，常规镜头复用 `shotCache` 供后续 `deliver` 命中，涉及 `blender` 时隔离快照副本并核验 `lut`，补渲后仍有目标帧缺失时显式抛 `contract.delivery-mismatch` 而不静默空关键帧进入 L5；同片同修订并发审片共享在途补渲，仅由发起方经 `server.mjs` 将本次补渲 `frames` 与 `gpuSeconds` 如实写入 `GET /ledger`，搭便车方记 `0` 不重复计账）。
  - `POST /v1/films` 传入非空白 `brief` 时无论亲手还是委托模式均持久化至 `meta.brief`；`runHandsOnAgent()` 转发 `POST /v1/films` 或 `POST /v1/films/<id>/review` 时，仅当 `body` 省略/`null` 或 `body.brief` 省略/`undefined`/空白字符串时自动在副本中补回已传入的需求原文（不篡改原参数，显式非空字符串原样保留，显式非法类型如对象、数组、数字、布尔、`null` 原样透传给服务端返回 `400 usage.bad-argument`）；审片与交付传入 L5 的需求原文按 `request brief -> meta.brief -> meta.question.brief -> film.title` 逐级兜底；审片提示词明确说明 `keyframe-f<帧号>` 为未缩放原尺寸关键帧。
- **报告顶层 `ok` 与 `verification.ok` 对齐且并排展示未处理审片意见数（`pipeline.mjs`、`work.mjs`、`comp/deliver.mjs`）**：
  - `writeVerification(dir, verification)` 将顶层 `ok` 对齐为 `Boolean(report.ok && verification?.ok !== false)`，并紧邻 `ok` 之后并排写入非负整数 `unresolvedReviewOpinions`（成立 L5 审片意见 `verification.L5.opinions.length`），重建 `report.json` 并重新锚定 `run.json` 摘要；`deliver` 作业响应 `data` 同步带出 `unresolvedReviewOpinions`。
  - `verifyDeliveryBundle(dir)` 强制校验 `checksOk && report.ok === (checksOk && report.verification?.ok !== false)`：纯 `comp` 交付包仍须 `checksOk && report.ok === true`，硬门未过的交付包须 `report.ok === false` 才过完整性复验，错配（如 `ok: true` 配 `verification.ok: false`）或 `checks` 失败一律拒收。
  - 改动后运行 `BEIMING_BLENDER=/nonexistent/blender node --test beiming/api/m1b-visual-review.test.mjs` 与 `node --test beiming/comp/comp.test.mjs`。

