# 北冥 HTTP API

在仓库根目录运行。两个进程用同一数据目录，账户令牌只在签发时输出一次。

```sh
node beiming/api/cli.mjs issue-token --data-dir .beiming-api
node beiming/api/cli.mjs serve --data-dir .beiming-api --port 8080
```

请求用 `Authorization: Bearer <token>` 鉴权。先用账户令牌读 `GET /v1/guide`、查卡和资产，再向 `POST /v1/films` 提交 `{ "template": "turntable" }`。返回的 `data.film` 是片号，`data.token` 是该片的工作区令牌。转台模板用原生 Blender/Cycles 卡加载显卡资产，第二镜头用 Three 片名卡，都是 `cards-data`。脚手架也支持单镜头 `title`。M1a 卡搜索包含已复现的卡，每次最多五张。

用工作区令牌读 `GET /v1/films/{id}/film` 取 `data.rev`，向同一路径 PUT `patch/0.1` 或带 `rev` 的 `film/3.0`。过期写入返回 HTTP 409 和 `data.latestRev`。有机器修法时，可向 `?applyFixes=machine` 交同一补丁，或只交当前 `rev` 重试。整片原样 PUT 返回当前修订。上传网格返回的 `data.ref` 可绑到镜头 `assets`。签锁失败拒绝本次写入。服务器管理员可用 `--local-trusted` 开放经过 L1 扫描的本地镜头脚本写入。

`render`、`verify`、`deliver` 接受 `wait`（0 至 30 秒）。响应里的 `data.job` 可接着 `GET /v1/jobs/{id}?wait=30`。渲染后用 `observe/query` 查帧、`observe/sheet` 取联系表，交付后用 `observe/metrics` 查成片。带同一令牌 GET `outputs[].url` 下载产物。交付目录有 master.mp4、web.mp4、contact.png、report.json、run.json、film.lock。未配置视觉模型时，报告的 L5 为 `not-run`。没改的镜头再渲、再交付走帧缓存，不调帧源，账本只数真渲的帧。

程序入口 `index.mjs` 导出 `startServer({ dataDir, port: 0 })`、`issueAccountToken`、合同、信封及模型客户端。`startServer` 默认监听回环，返回 `{ server, url, port, close }`，关闭时 `await close()`。渲染需要 Blender、FFmpeg（含 ffprobe）及页面宿主用的 Playwright 无头浏览器。

`runHandsOnAgent` 只经 `http_request` 一个工具操作 API。用 `BEIMING_AGENT_ENDPOINT`、`BEIMING_AGENT_MODEL`、`BEIMING_AGENT_API_KEY` 配模型，用 `ledgerPath` 指定外部用量账本。视觉审片用 `BEIMING_REVIEW_*` 配置，服务端把用量写进数据目录的 `external-ledger.jsonl`。

委托模式：`POST /v1/films` 带 `{ "mode": "delegate", "brief": "…", "budget": { "tokens", "gpuSeconds", "wallSeconds" } }`，脚手架模板由服务端按需求与资产确定性判定（`selectDelegateTemplate`），返回 `data.job`，用 `GET /v1/jobs/{job}?wait=30` 等终态。服务端用 `delegate.mjs` 的 `runDelegateOrchestrator` 只经本服务的 `/v1/*` 依次起导演（查卡、立 `predicates.extra`、排镜）、每镜头独立新会话镜头工（五段任务书起始上下文 `<= 15,000` token，未过重试一次）和收尾员；L5 视觉审片执行三视角各 3 票（每票前查预算、两票成立、过 L1 的建议谓词记入 `validatedExtraPredicates`、不推翻硬门）。模型配置读 `startServer({ delegate })` 或 `BEIMING_AGENT_ENDPOINT`、`BEIMING_AGENT_API_KEY`，导演与镜头工分别可用 `BEIMING_DIRECTOR_MODEL`、`BEIMING_WORKER_MODEL` 覆盖 `BEIMING_AGENT_MODEL`。每片最多花 120 万 token；没有账户级配额与并发上限。调模型前读 `GET /v1/films/{id}/ledger`，token（含预留，默认 2 万且不超过预算上限）、墙钟、显卡秒（含在跑子作业的实时用量）任一到线就停，作业以 `stopped` 结束，带 `stoppedReason`、`stoppedAt`（`<角色>:step-<n>`）、`bestRev` 与 `cost`。六件套已交到最新修订时按 `succeeded` 收尾。委托作业不占显卡槽；取消委托作业（`DELETE /v1/jobs/{job}`）会同时取消该片所有排队或在跑的渲染、核验、交付作业；崩溃重启后遗留的 `running` 委托作业收敛为 `stopped`（`reason: 'interrupted'`）。

合同与预算见 [OpenAPI](./openapi.json)。改合同后运行 `node beiming/api/contract.mjs --write`，再运行 `node --test beiming/api/api.test.mjs`。冻结信封与诊断口径见[信封契约](../kernel/contracts/envelope/CONTRACT.md)和[错误码表](../kernel/contracts/errors/CONTRACT.md)。

## 命令行薄壳与 MCP 薄壳

两个薄壳由合同 `ROUTES` 生成，动词名就是 `operationId`。服务地址取 `--url` 或 `BEIMING_API_URL`，令牌取 `--token` 或 `BEIMING_API_TOKEN`。

```sh
node beiming/api/cli.mjs --list-verbs
node beiming/api/cli.mjs film-put --help
node beiming/api/cli.mjs artifacts --id f_001 --name contact.png --out contact.png
node beiming/api/cli.mjs mcp --url http://127.0.0.1:8080 --token <账户令牌>
```

命令行的标准输出是一行信封；`artifacts` 不带 `--out` 时是文件的原始字节。退出码按错误码前缀取，只有 0、1、2、3、4、5、124。`mcp` 在 stdio 上把同一组动词提供成 MCP 工具，图片产物直接以图片内容返回。选项、退出码表、令牌选择、取图规则与镜头帧缓存见 [DETAILS.md](./DETAILS.md)。
