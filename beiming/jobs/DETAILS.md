# 作业：细则

[README.md](README.md) 是接口索引与维护约定；这里放字段口径、示例代码与锁时序。自检命令见 README。

## 作业成本账本

队列里的作业每一轮到终态（`succeeded`、`failed`、`stopped`、`canceled`）时，`queue.mjs` 自动往工作区的 `jobs/ledger.jsonl` 追加一行 `job-ledger/0.1`，不用调用方自己记：

| 字段 | 含义 |
|---|---|
| `seq` | 账本内严格递增的行号，跨进程追加也不重号 |
| `jobId`、`attempt`、`kind`、`handler`、`rev`、`status` | 哪个作业的第几轮、作业类型、执行器、修订号（未提交快照没有 `rev`）、终态 |
| `wallMs` | 这一轮的墙钟毫秒 |
| `gpuSeconds`、`gpuKnown` | 显卡秒，以及它是不是实测 |
| `tokensByTier`、`totalTokens` | 按 fable / opus / sonnet / haiku / other 档位分的 token 与合计 |
| `renderedFrames`、`deliveredFrames` | 渲帧数、交付帧数 |
| `diskBytes` | 收尾时工作区里常规文件的字节数 |

- **位置**：`jobs/` 不属于作品输入，账本不进快照、不改快照哈希。旁边的 `ledger.jsonl.lock` 是写入锁，记账完就删。
- **磁盘采样**在清理本轮中间产物前完成。`measureDiskBytes(dir)` 要求调用方传入可信根目录，跳过符号链接和根目录下的 `cache/`；更深层的同名目录照常计量。历史帧缓存不会抬高本次报价。账本锁短时繁忙（包括 Windows 正在删除锁文件）时退避重试，父目录消失等错误仍会报告。汇总对磁盘取峰值 `maxDiskBytes`，对其余成本求和。
- **崩溃恢复**以原子落盘的 `job.json` 终态事件为准（WAL）。事件先保存这一轮的成本，随后队列追加账本。`queue.readLedger()`、`queue.summarizeLedger()`、`queue.replay(id)` 和显式调用 `queue.reconcileLedger()` 都会按 `(jobId, attempt)` 补齐已有结算载荷的缺行。旧作业缺少载荷时保留原有记录。
- **执行器怎么回报**：成功时在返回值里带 `cost`，失败时把 `cost` 挂在抛出的错误上（`throw Object.assign(new Error('渲染失败'), { cost })`）。`cost` 可以有 `gpuSeconds` 或 `frameMetas`（每帧 `timing.renderMs`，两样都给时用 `gpuSeconds`）、`tokensByTier`、`renderedFrames`、`deliveredFrames`，也可以用 `wallMs`、`diskBytes` 覆盖队列自己的实测。没回报的维度记 0。
- **`gpuKnown` 口径**：回报了 `gpuSeconds` 或 `frameMetas` 是 `true`；都没回报时 `gpuSeconds` 记 0、`gpuKnown` 是 `false`，表示「没有实测」而不是「没用显卡」。汇总里的 `gpuUnknownRows` 不为 0 时，显卡秒合计只是下限。`beiming/api/` 的执行器目前不回报 `cost`，它们的行就是这种情况，显卡秒仍在旧 API 账本里。
- **幂等与新轮次**：同一个 `(jobId, attempt)` 只记一次，重复结算（崩溃后重放、调用方重试）读回已有的那一行，不再追加。`queue.replay(id)` 开的是新一轮，`attempt` 加一，确实又花了一次钱，所以记新行。排队中取消、重放时补记的中断也各记一行，没有执行时间的墙钟是 0。
- **记账失败**时作业照常到终态，终态事件用 `ledgerError` 记录原因。执行器省略 `cost` 或传 `undefined` 均按缺省成本结算。显式 `null`、`Map` 等非法 `cost` 或非法 `tokensByTier` 会使本轮无法结算。账本故障不阻止 `replay` 执行新轮次；读账、汇总和显式补账仍会报错。若成本有效但追加时遇到账本损坏或等锁超时，载荷保留，故障排除后可自动补账。`ledgerError` 是当时的诊断，不代表现在仍缺行。
- **坏数据**：写入与读回过同一套校验。坏入参不落盘；读到坏行（不是合法 JSON、缺字段、字符串型数字、未知档位）报「第 N 行损坏」，N 是文件里的物理行号。
- **旧 API 账本**：`beiming/api/` 写的 `<数据目录>/meta/<片子>.ledger.jsonl` 是另一种行。默认严格模式不认它；用 `readJobLedger(file, { allowLegacyApiRows: true })`（`summarizeJobLedger` 同样接这个选项）读时，作业终态行映射成同样的六维并标 `legacyApiRow: true`，请求流水行与钩子行跳过。旧行的 token 不分档，`tokens` 与 `modelTokens` 都归进 `other`；没有的维度（交付帧数、磁盘字节）是 0。

下面的示例假定 `workspaceDir` 已包含有效的 `film.json` 和镜头输入。

```js
import { appendJobLedger, loadQueue, openWorkspace } from './index.mjs';

openWorkspace(workspaceDir).commitRevision(0);

const queue = loadQueue(workspaceDir, { handlers: {
  draft: async () => ({ cost: { gpuSeconds: 3, renderedFrames: 2, tokensByTier: { sonnet: 1200 } } }),
} });

// 1 草稿报价：草稿跑完，拿它在账本里的实测给终渲报价（不取整，溢出报错）
const draft = queue.enqueue({ kind: 'draft', rev: 0 });
await queue.runJob(draft.id);
const quote = queue.quoteJobFromDraft({ draftJobId: draft.id, draftSize: [960, 540], draftSamples: 16,
  targetFrames: 180, targetSize: [1920, 1080], targetSamples: 32 });
// quote.estimatedGpuSeconds === 3 / 2 * 4 * 2 * 180

// 2 终态结算：上面的 runJob 到终态时已经自动记了一行
const [row] = queue.readLedger(); // { format: 'job-ledger/0.1', seq: 1, jobId: 'job-1', attempt: 1, gpuKnown: true, ... }

// 3 重放幂等：同一轮再结算一次读回原行；replay 是新一轮，记第二行
appendJobLedger(queue.ledgerFile(), row); // 交回 row，账本还是 1 行
await queue.replay(draft.id);             // attempt 2，账本 2 行

// 4 汇总读回
const sum = queue.summarizeLedger(); // { count: 2, succeeded: 2, gpuSeconds: 6, gpuUnknownRows: 0, ... }
```

不经过队列时直接用 `appendJobLedger(file, entry)`、`readJobLedger(file)`、`summarizeJobLedger(rowsOrFile)` 与 `quoteFromDraft(draft)`，行为相同。

## 镜头帧缓存（A16）

`cache.mjs` 按 04 §10 的六项给每一帧算 sha256 键：① 本镜头的规范化 JSON（`in`/`out` 归一为帧数，只含这个镜头）；② 实际加载文件的哈希；③ `tracks` 哈希（没有写 `'none'`）；④ 所用卡的三段版本与实现哈希（取自 `film.lock`）；⑤ 帧源、运行时、浏览器构建、显卡后端、驱动；⑥ 档位、采样数、尺寸、镜头局部帧号、`sub` 采样集。缺一项或类型不对直接抛错，不退化成撞键。

- `computeFrameCacheKey(spec)`、`canonicalJson(value)`：返回的 `components` 可定位哪一项变化；数值 `-0` 与 `0` 不同键。调用方负责提供完整依赖：把影响画面的片级 `fps`、`seed`、风格等放进可选 `film` 对象，把本镜实际使用的事件放进 `events`。不要传整片镜头表；依赖全片位置的镜头应将该位置显式进键，否则平移镜头不会失效。
- `openShotCache(dir)` 返回 `{ root, get, put, invalidateShot, prune }`。头部与颜色层在同一文件内原子替换，读时分别验证 SHA-256；旧格式冷启动，不信任缺少轮次的旧帧。使用由可信作业进程独占管理的目录，不接受符号链接根。顶层 `cache/` 不进快照也不计作业磁盘成本；多个工作区也可使用同一专用目录。`prune({ maxAgeMs, clearDraft })` 默认清七天前的条目，终稿每镜只保留最近用过的一版，草稿可整批清理。它不做抽样保留或单独归档元数据。
- **锁与只读缓存的三条维护约定**：① 命中读取不要求写权限，`get` 读有效帧不进锁，只读目录（`0555`）里的只读帧（`0444`）遇到 Windows 短时共享冲突照样退避重试，逐段检查路径与读取帧在同一次退避里，哪一步冲突都不会变成假未命中；② 无法持锁时不得发布或删除：`put` 的改名到位与「核对身份后删除」都在缓存根目录的 `.cache.lock` 里做，根只读或别的进程久占锁时 `put`、`prune` 直接抛错（等锁超时的错误 `code` 是 `ETIMEDOUT`，`prune({ lockTimeoutMs })` 可调等待上限，默认 10 秒），`get` 遇到坏帧只短等 200 毫秒，等不到锁或建锁、删除遇到任何文件系统错误（磁盘满、句柄用尽、只读，含 Windows 上认不出的 `UNKNOWN`）就留着坏帧、按未命中返回；③ `prune` 返回的 `removed` 只统计实际删除的旧帧，不统计因期间有新发布而被保护下来的新帧。同一进程里指向同一根目录的多个 `openShotCache` 句柄共用一份持锁状态与发布序号（按根目录的设备号与节点号认，大小写不敏感的卷上写法不同也算同一个根；每次操作按那一刻根路径上的物理目录认，不在打开句柄时固定，根目录被改名轮换、原路径重建后新旧句柄仍共用一份状态；拿到锁之后按锁所在的那一代目录认），临界区里重入不会自己等自己；持锁状态只在真正拿到 `.cache.lock` 之后才置位，还在等锁时重入的调用同样要等锁。
- `renderShotsWithCache({ shots, cache, renderFrame, filmId })`：命中不调 `renderFrame`，只改第二镜时第一镜实际渲染 0 帧。返回帧记录中的 `frame` 是局部帧号；`meta.frame` 是本轮全片帧号，`meta.shotFrame` 是局部帧号。传当前 `filmId` 可刷新 `meta.film`，命中不沿用旧片名；命中帧的 `timing` 归零，新渲帧保留实测耗时。交付前检查 `run.ok`，再读取 `cache.get(record.entry)`，**只有其 `colorSha256` 与 `record.colorSha256` 相同才使用该读取的字节**；缓存被清理或被并发覆盖时要重试，不能只按键交付。
- `checkCacheSeams(frames, { determinism, seamFactor = 3, minSpikeFloor = 0.015 })`：`tolerance` 档以相邻帧的写入 `runId` 不同为交界，即使本轮全命中也检查；无轮次的旧调用可传 `fromCache`。交界差超过 `max(minSpikeFloor, seamFactor × 非交界差中位数)` 报尖峰。自动修复先使本镜当前版本的所有帧失效，再整镜重渲；`renderedFrames` 计实际调用，可能大于交付帧数。设 `rerenderOnSeamSpike: false` 只报告失败，重试不会抹去轮次差异。

接缝检查是启发式守卫，不是像素一致性证明。渲染器需提供同尺度、同布局的 `colorFloats`；缓存按内存顺序压成最多 64 段的均值，局部差异可能被平均抵消，快速运动也可能误报。混轮且缺少可比特征时不能判通过。A17 的 20 次重复和 V14 的重建测试必须**每次使用独立的空缓存目录**，或在调用层禁用复用（`noCache`），否则测到的是缓存命中而非重新渲染。

## 锁与暂存目录的回收时序

`withFileLock`（账本锁、作业锁、缓存的 `.cache.lock`）与 `atomicWrite` 都先在目标目录里建暂存目录，再用硬链接或改名一步发布。持有期间目标目录随时可能被改名轮换、原路径上重建出新目录，所以回收只按创建时就定下的凭据认，不靠节点号：

1. **暂存目录**名是 `.write-<UUID>`，名字在 `mkdir` 之前就定好。回收时原路径上有就删；没有就列出上一级的兄弟目录（列目录遇到共享冲突退避重试），删掉里面同名的那个。
2. **锁文件**内容是 `<进程号> <UUID>`，同样在建锁之前定好。进程号给陈旧锁清理用（只读第一段，旧格式只有进程号的锁照常清理）；UUID 是这一次持锁的凭据。
3. **释放锁**时每次尝试（含退避重试）都先认主：节点号与建锁时记下的对得上，或者内容是自己的凭据，才删。节点号在硬链接之前就从暂存文件上取到；对得上就不用开文件，句柄耗尽时照样能放锁。原路径上的不是自己的（那是新目录里别人的锁）就到兄弟目录里找自己的那个删掉；上一级已经不在了、或兄弟目录里都没有，才什么也不删。原路径上的锁认不出来（节点号为 0 又读不了内容）、或上一级还在却退避用完仍列不出来（持续 `EBUSY`、句柄耗尽）时报错，不悄悄留下。
4. 从 `mkdir` 暂存目录到硬链接成功之间任何一步遇到轮换，这一次建锁按竞争失败处理、暂存目录按第 1 条回收，然后在新目录里重新建锁。
5. **硬链接成功之后先复核再进临界区**：原路径上确实是自己的锁才调回调。硬链接刚成功目录就被轮换的话，自己的锁落在旧目录里，原路径上是空的新目录或别人的锁：这时按第 3 条回收旧目录里的锁，按剩余等待时间在原路径上重新取；新目录的锁一直被别人占着就照常报 `ETIMEDOUT`，回调一次也不执行。
6. **临界区里的读写认锁所在的那一代目录**：`withFileLock(file, run)` 把一个解析函数传给回调，每次调用按第 3 条的认主规则返回「自己的锁旁边的那个目标路径」。账本追加用它读账、写账（读完再认一次，目录在读账途中被轮换就重读）；作业终态回写用它定位 `job.json`；缓存用它认持锁状态与「核对身份后删除」的帧路径，发布时锁不在原路径上就按目录不在了处理、补建后重来。原路径上新目录里的文件不在这把锁的保护范围内，不读也不写。
7. **放不掉锁要报错，并且能恢复**：释放失败时 `withFileLock` 抛出原错误（回调自己先抛了错就报回调的错），同时在进程内登记这把锁的 UUID。本进程还活着，按进程号的陈旧锁清理不会碰它；下一次有人在这个进程里取同一把锁时，按登记的 UUID 认出来删掉再取。登记只在本进程内有效：别的进程要等这个进程退出后按进程号清理。

拿不到节点号（节点号为 0）的文件系统上这套回收照常成立，只凭名字与内容里的 UUID。缓存另按根目录的设备号与节点号认「同一个根」；节点号为 0 时退回内核给出的真实路径并原样比较，不转小写：区分大小写的卷上只差大小写的是两个缓存根，各用各的锁；本地 APFS、NTFS 上内核已把写法归一。节点号为 0 且内核不归一大小写的卷（个别 FUSE、网络盘）上，同一根的两种写法在临界区里重入会等到锁超时报错，这时统一用一种写法打开缓存。

这是尽力而为：认主之后、删除（或读写）之前的一瞬间再被轮换且新目录里已有别人的锁或文件，按路径操作的接口分不出来。兄弟目录是逐个探的，只在轮换之后才走到；上一级目录极多时会慢。锁文件内容多了 UUID，本次改动之前的代码读不了它，新旧版本不要同时操作同一个工作区或缓存目录。进程在持锁时被杀留下的锁由下一个等锁者按进程号清掉；留在缓存根里的 `.write-*` 由 `prune` 清掉放久了的。
