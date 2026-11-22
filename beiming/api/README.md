# 北冥 HTTP API

在仓库根目录运行以下命令。两个进程使用同一数据目录，账户令牌只在签发时输出一次。

```sh
node beiming/api/cli.mjs issue-token --data-dir .beiming-api
node beiming/api/cli.mjs serve --data-dir .beiming-api --port 8080
```

请求通过 `Authorization: Bearer <token>` 鉴权。先用账户令牌读取 `GET /v1/guide`、查卡和资产，再向 `POST /v1/films` 提交 `{ "template": "turntable" }`。返回的 `data.film` 是片号，`data.token` 是该片的工作区令牌。转台模板用原生 Blender/Cycles 卡加载显卡资产，第二镜头用 Three 片名卡。两镜头均为 `cards-data`。脚手架也支持单镜头 `title`。M1a 卡搜索包含已复现的卡，每次最多五张。

用工作区令牌读取 `GET /v1/films/{id}/film` 取得 `data.rev`，向同一路径 PUT `patch/0.1` 或带 `rev` 的 `film/3.0`。过期写入返回 HTTP 409 和 `data.latestRev`。有机器修法时，可向 `?applyFixes=machine` 提交同一补丁，或只交当前 `rev` 重试。整片原样 PUT 返回当前修订。上传网格返回的 `data.ref` 可绑定到镜头 `assets`。签锁失败会拒绝本次写入。服务器管理员可用 `--local-trusted` 开放经过 L1 扫描的本地镜头脚本写入。

`render`、`verify`、`deliver` 接受 `wait`（0 至 30 秒）。响应里有 `data.job`，可继续请求 `GET /v1/jobs/{id}?wait=30`。渲染后可用 `observe/query` 查帧、`observe/sheet` 取联系表，交付后用 `observe/metrics` 查成片。带同一令牌 GET `outputs[].url` 即可下载产物。交付目录中有 master.mp4、web.mp4、contact.png、report.json、run.json、film.lock。未配置视觉模型时，报告的 L5 为 `not-run`。

程序入口 `index.mjs` 导出 `startServer({ dataDir, port: 0 })`、`issueAccountToken`、合同、信封及模型客户端。`startServer` 默认监听回环，返回 `{ server, url, port, close }`，关闭时请 `await close()`。渲染需要 Blender、FFmpeg（含 ffprobe）及页面宿主使用的 Playwright 无头浏览器。

`runHandsOnAgent` 通过唯一的 `http_request` 工具操作 API。用 `BEIMING_AGENT_ENDPOINT`、`BEIMING_AGENT_MODEL`、`BEIMING_AGENT_API_KEY` 配置模型，并用 `ledgerPath` 指定外部用量账本。视觉审片使用对应的 `BEIMING_REVIEW_*` 配置，服务端将其用量写入数据目录的 `external-ledger.jsonl`。

合同与预算见 [OpenAPI](./openapi.json)。修改合同后运行 `node beiming/api/contract.mjs --write`，然后运行 `node --test beiming/api/api.test.mjs`。冻结信封与诊断口径见[信封契约](../kernel/contracts/envelope/CONTRACT.md)和[错误码表](../kernel/contracts/errors/CONTRACT.md)。

## 命令行薄壳与 MCP 薄壳

两个薄壳都由合同 `ROUTES` 生成，动词名就是 `operationId`（`guide`、`films-create`、`film-put` 等），只经 HTTP 调服务。服务地址取 `--url` 或 `BEIMING_API_URL`（默认 `http://127.0.0.1:8080`），令牌取 `--token` 或 `BEIMING_API_TOKEN`。

```sh
node beiming/api/cli.mjs --list-verbs
node beiming/api/cli.mjs film-put --help
node beiming/api/cli.mjs films-create --json '{"template":"turntable"}'
node beiming/api/cli.mjs render --id f_001 --wait 30 --json '{"tier":"draft"}'
node beiming/api/cli.mjs artifacts --id f_001 --name contact.png --out contact.png
node beiming/api/cli.mjs mcp --url http://127.0.0.1:8080 --token <账户令牌>
```

命令行里路径参数和查询参数是同名选项，请求体用 `--json` 或 `--body-file`（`film-files` 用 `--text`，`film-assets` 可用 `--file` 直接上传网格）。标准输出是一行信封。退出码按错误码前缀取：成功 0，`usage.` 2，`env.` 3（连不上服务也算），`contract.` 与 `auth.` 4，`busy.` 5，`timeout.` 124，其余 1。

`mcp` 在 stdio 上把同一组动词提供成 MCP 工具，入参是路径参数、查询参数和 `body`。建片交回的工作区令牌与作业归属会自动记住。`artifacts` 取到的 PNG、JPEG、WebP、GIF，以及 `observe-sheet` 等信封 `outputs` 里的图片，直接以图片内容返回；其他二进制只回字节数与 SHA-256。入参规则、令牌选择、图片上限与程序接口见 [DETAILS.md](./DETAILS.md)。
