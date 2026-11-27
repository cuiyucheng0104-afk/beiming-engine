# 作业

管理作业调度、缓存、资产库和账本。

通过契约接收协议组件的作业请求、交接作业输入与产物。

业务契约：[片子描述](../kernel/contracts/film/CONTRACT.md)（作业输入）、[锁文件](../kernel/contracts/lock/CONTRACT.md)（种子、版本与哈希，缓存与复跑按它对齐）。

通用约定见[契约目录](../kernel/contracts/)、[契约写法约定](../kernel/contracts/CONVENTIONS.md)和[目录归属契约](../kernel/contracts/ownership/CONTRACT.md)。

字段口径、示例代码与锁时序见 [DETAILS.md](DETAILS.md)。

## 接口索引

统一出口是 `index.mjs`。

| 模块 | 导出 | 用途 |
|---|---|---|
| `workspace.mjs` | `openWorkspace` | 修订提交、内容寻址快照、中间产物回收 |
| `scheduler.mjs` | `Scheduler` | 显存预算调度与抢占（[道](DETAILS.md#调度器的道)） |
| `queue.mjs` | `loadQueue`、`replayJob` | 持久化作业队列，到终态自动记账 |
| `ledger.mjs` | `appendJobLedger`、`readJobLedger`、`normalizeLedgerEntry`、`summarizeJobLedger`、`quoteFromDraft`、`measureDiskBytes` | 六维成本账本与草稿报价 |
| `cache.mjs` | `computeFrameCacheKey`、`canonicalJson`、`openShotCache`、`renderShotsWithCache`、`checkCacheSeams` | 镜头帧缓存（A16） |
| `sandbox.mjs` | `runInWorkspaceSandbox`、`enforceAuthorMode`、`WarmProcessPool` 等 | 工作区沙箱（A13） |
| `watchdog.mjs` | `runWithWatchdog`、`createJobWatchdog`、`killProcessTree` 等 | 看门狗（A14） |
| `sandbox-redteam.mjs` | `runSandboxRedTeam`、`formatRedTeamReport`（不经 `index.mjs`） | 红队实测 |

## 作业成本账本

作业每一轮到终态，队列往工作区的 `jobs/ledger.jsonl` 追加一行 `job-ledger/0.1`：墙钟、显卡秒（`gpuKnown` 标明是不是实测）、分档 token、渲帧数、交付帧数、磁盘字节。同一个 `(jobId, attempt)` 只记一次，`replay` 记新行。账本不进快照。记账失败不扣住作业，原因写在终态事件的 `ledgerError`。执行器用返回值或错误上的 `cost` 回报成本。

## 镜头帧缓存（A16）

每一帧的 sha256 键按 04 §10 的六项算，缺一项或类型不对直接抛错：

1. 本镜头的规范化 JSON（`in`/`out` 归一为帧数，只含这个镜头）
2. 实际加载文件的哈希
3. `tracks` 哈希（没有写 `'none'`）
4. 所用卡的三段版本与实现哈希（取自 `film.lock`）
5. 帧源、运行时、浏览器构建、显卡后端、驱动
6. 档位、采样数、尺寸、镜头局部帧号、`sub` 采样集

- `openShotCache(dir)` 返回 `{ root, get, put, invalidateShot, prune }`。文件头与颜色层在同一文件里原子替换，读回各验 sha256，坏帧按未命中。
- `renderShotsWithCache`：命中不调 `renderFrame`，只改第二镜时第一镜渲染 0 帧。交付前查 `run.ok`，并且只用 `colorSha256` 与帧记录相同的读回字节。
- `checkCacheSeams`：`tolerance` 档在写入轮次的交界查帧间尖峰，默认先失效再整镜重渲。它是启发式守卫，不是像素一致性证明。
- 重复性与重建测试每次用独立的空缓存目录，否则测到的是命中。

维护约定：

1. **命中读取不要求写权限**。`get` 不进锁，只读缓存照常命中；共享冲突退避重试，不变成假未命中。
2. **拿不到 `.cache.lock` 就不发布也不删除**。`put`、`prune` 直接抛错（等锁超时是 `ETIMEDOUT`）；`get` 清坏帧遇到文件系统错误就留着坏帧、按未命中返回。
3. **只删自己建的，只在自己锁住的目录里写**。锁与暂存目录按创建时定下的 UUID 凭据认主，缓存根被改名轮换后照样回收；放不掉锁就报错，不报成功。时序与限制见 [DETAILS.md](DETAILS.md)。`prune` 的 `removed` 只计实际删掉的旧帧。

## 工作区沙箱（A13）

`runInWorkspaceSandbox` 先过 U8 守卫：请求、`shot`、`film.shots[]` 及其 `renderer` 的自有 `mode` 须是 `cards-data` 且不带 `entry`（否则 `contract.unsupported-mode`），`files` 查相对路径。调用方把出帧的镜头放进请求并固定工作区根与引擎目录：卷根、互相包含、家目录点目录都拒收。沙箱无网络、根只读、非 root，只挂本工作区与只读引擎目录，环境变量走白名单，超时或退出后回收后代进程并关管道。后端只认 `oci`、`darwin-seatbelt`、`portable`（无内核隔离，要 `allowDegraded: true`）。红队：`node beiming/jobs/sandbox-redteam.mjs`，全拦才 exit 0。

## 配额看门狗（A14）

`runWithWatchdog` 拿调度器租约跑任务，越线就强杀受管进程树再还租约：单帧超时、着色器挂起或 GPU 丢失、显存超限、工作区磁盘超限（`intermediate/`、`deliver/`、`cache/` 全算，不跟符号链接）。出帧放在受管子进程里。错误码、配额键与探针见 [DETAILS.md](DETAILS.md)。

## 自检

从仓库根目录运行：

```sh
node --test "beiming/jobs/*.test.mjs"       # 全部
node --test beiming/jobs/watchdog.test.mjs  # 单跑一份：jobs、ledger、cache、sandbox、watchdog
```

这里是作业层的缓存核，不代表 API 渲染路径已接入。
