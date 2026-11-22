# 作业：细则

[README.md](README.md) 是接口索引与维护约定；这里放字段口径、示例代码、沙箱隔离细则与锁时序。自检命令见 README。

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

## 工作区沙箱（A13）

`sandbox.mjs` 给每个工作区的每个作业起一个一次性沙箱。隔离策略只有一份（隔离规格），三种后端各自把它渲染成要起的进程。

### U8 守卫

`enforceAuthorMode(request, workspaceDir?)` 在生成规格之前执行，`runInWorkspaceSandbox` 每次都调，不带 `request` 也按拒收算。它查四处：请求自己、`request.shot`、`request.film.shots[]` 里的每个镜头，以及这些镜头各自的 `renderer`（写了 `renderer` 时出帧用的是它那一套，见片子描述契约 3.3）。每一处都必须是普通对象（原型是 `Object.prototype` 或没有原型），并且只认自有属性：从原型链继承来的 `mode` 不算数。下面几种一律报 `contract.unsupported-mode`：

- 任何一处的 `mode` 不是 `cards-data`：写成 `build-script`、`native-code`，或者自己没写；
- 任何一处出现 `entry`（值是 `undefined` 也算出现），或者请求带了调用方自己的执行命令 `command`；
- 请求、镜头、`renderer`、`film` 不是普通对象（类实例、数组、`Object.create(...)` 造的对象、字符串）；`film` 没有非空的 `shots` 数组，或者数组里有空位；
- `files` 里有扩展名不在数据白名单里的文件（JSON、表格、字幕、图片、模型、音视频、字体之外的都不收，没有扩展名的也不收）。

`files` 里的路径还要过 `workspace.mjs` 的 `safePath`，写法不对报 `contract.bad-path`：`..` 段、`.` 段、前导 `/`、空段、反斜杠、冒号、Windows 设备名，以及 ASCII 控制字符（`\x00`–`\x1f` 和 DEL `\x7f`；含控制字符的不管扩展名对不对都报这个码）。`runInWorkspaceSandbox` 在规格生成之后带着真实工作区目录再查一遍，经过工作区里符号链接的路径也拒收。

调用方要保证的两件事，守卫自己查不了：

- **把实际交给帧源的镜头放进请求**（`shot` 或整份 `film`）。请求里没带的镜头，守卫看不到。
- **清单和磁盘一致**。守卫看的是调用方报上来的清单，不扫工作区目录；写文件的一方要保证清单和实际写入一致。

### 隔离规格

`buildContainerSpec({ workspacesRoot, workspaceDir, appDir, command, image })` 交回规格，`validateContainerSpec(spec)` 交回违例说明（空数组才合格）。建规格时自己先校验一遍，不合格报 `usage.bad-argument`。

| 项 | 取值 | 校验 |
|---|---|---|
| 工作区 | `fs.realpathSync.native` 之后必须是工作区根的直接子目录（`path.dirname(工作区) === 工作区根`），目录名只用小写字母、数字、连字符 | 根本身、嵌套目录、根外目录、路径里的 `..` 段、符号链接（含 Windows 目录联接）、宿主机敏感目录（见下）都报 `contract.bad-path`；工作区根或工作区写成根目录、盘符卷根的同样报这个码 |
| 工作区根 | 本进程里出过合格规格的工作区根与引擎目录都登记在册（规范化后） | 新的工作区根和登记过的另一个工作区根互相包含（父子任一方向），或者和登记过的引擎目录互相包含，报 `contract.bad-path` |
| 容器名 | `bm-ws-<工作区标识>-<8 位随机十六进制>` | 每次不同，必须绑定工作区标识 |
| 网络 | `none` | 只能是 `none` |
| 根文件系统 | 只读，另给一个 `/tmp` 的 tmpfs（`noexec,nosuid,nodev`，256 MB） | 不能可写，不能多 tmpfs |
| 权限 | `--cap-drop=ALL`、`--security-opt=no-new-privileges`、非 root 用户、`--pids-limit 256` | 多一条 `security-opt`、uid 是 0、进程数不设限都不合格 |
| 挂载 | 只有两处：本工作区到 `/workspace`（读写），引擎目录到 `/app`（只读） | 多挂一处（兄弟工作区、家目录、Docker socket）、引擎目录可写、引擎目录与工作区根（含登记过的）互相包含、引擎目录是宿主机敏感目录、挂载源是根目录或盘符卷根、挂载源路径含逗号、引号或 ASCII 控制字符（`\x00`–`\x1f`、`\x7f`，含回车），都不合格 |
| 环境变量 | 固定六个：`HOME=/tmp/home`、`TMPDIR=/tmp`、`LC_ALL=C`、`PATH`、`BEIMING_WORKSPACE=/workspace`、`BEIMING_APP=/app` | 不继承宿主机的任何变量，多一个就不合格 |
| 命令 | 以 `node` 开头的字符串数组，由服务端决定 | 别的可执行文件不合格 |

宿主机敏感目录有三类，工作区和引擎目录都不得是：根目录与盘符卷根（`/`、`D:\`、`D:/`、`D:`，不分大小写）；包住家目录的目录（家目录的上级、家目录本身）；家目录下任何一段以点开头的目录（`.ssh`、`.aws`、`.config`、`.gnupg`、`.claude`、`.kube` 以及它们里面的子目录）。家目录下不带点开头段的普通目录可以用。

卷根单独按写法认，不靠「包住家目录」：Windows 上另一个盘的卷根和家目录不在同一棵树里，`path.relative` 两个方向都给绝对路径。判定用 `path.parse` 加 `path.win32.parse`（先过 `path.win32.normalize`，`D://`、`D:/.` 一并算），所以在 POSIX 上碰到 Windows 写法也拒收。工作区根、工作区和引擎目录都在规范化之前先认调用方给的原始写法：POSIX 上当前目录里有叫 `D:` 的普通目录时，`D:/` 规范化后是一条普通路径，之后就认不出来了。工作区根规范化之后再认一次（`<顶层目录>/..` 这种写法规范化后才是卷根）。这一条只有路径语义上的单测，没有在真 Windows 上挂过别的盘。

登记册是进程内的，先到先得，没有注销接口：换工作区根或引擎目录要重启进程。它拦的是调用配置把挂载范围越扩越大，部署时仍应由服务端写死可信的工作区根与引擎目录，不从请求里取。

用户与宿主机相同（宿主机不是 root 时），挂进去的工作区才写得了；宿主机是 root 或没有 uid 的平台用 `65534:65534`。

### 三种后端

`detectSandboxBackend()` 按本机探测，也可以用 `backend` 指定。`planSandboxExec(spec, { backend, runtime, tmpDir, allowDegraded })` 只渲染不执行、不校验规格；执行只走 `runInWorkspaceSandbox`，它每次都先校验。

后端名默认拒绝：规划和执行两处都只认下表三个名字，别的（未知字符串、空串、非字符串，`toString`、`constructor` 这类原型链上的键）在起进程之前报 `usage.bad-argument`；`oci` 的 `runtime` 只认 `docker` 与 `podman`。`portable` 在两处都要调用方的选项对象上有自有的布尔值 `allowDegraded: true`，真值、字符串、从原型链继承来的都不算，否则报 `env.missing-tool`。普通宿主 node 子进程只是 `portable` 的渲染方式，不当别的后端的兜底。

| 后端 | 怎么起 | `isolation` | 边界 |
|---|---|---|---|
| `oci` | `docker run`（或 `podman run`）加上表的全部选项；要给带 node 的 `image` | `oci-container` | Linux 命名空间容器，和宿主机共用内核；用户命名空间与 seccomp 沿用运行时默认值。超时后另发 `kill` 停容器 |
| `darwin-seatbelt` | `/usr/bin/sandbox-exec -p <策略>`：`(deny default)`，只许执行 node，文件读只放行系统库、本工作区、引擎目录与专属临时目录，写只放行本工作区与专属临时目录，`(deny network*)`，`signal` 与 `process-info` 只对自己 | `seatbelt-process-policy` | 进程策略，不是容器：没有 PID、挂载、网络命名空间，`pids-limit` 与 tmpfs 大小不生效；`/` 下的目录名可以列出；凭进程号能分辨别的进程在不在（`EPERM` 对 `ESRCH`），读不到它的命令行与环境变量；超时只杀主进程，作业另起会话的后台进程不会被回收（仍受同一份策略约束，容器后端没有这个问题）。`sandbox-exec` 已被系统标为弃用 |
| `portable` | 直接起 node 子进程，只换环境变量和工作目录 | `needs-oci-runtime` | 没有内核级隔离，文件、网络、进程都拦不住。默认拒跑（`env.missing-tool`），自有的 `allowDegraded: true` 只给本机调试用，不得用于对外服务 |

宿主机后端（后两种）没有挂载命名空间：规格里的 `/workspace`、`/app`、`/tmp` 在命令参数、环境变量和工作目录里换成本机真实路径，`/tmp` 换成每次新建、跑完即删的专属临时目录。作业代码从 `BEIMING_WORKSPACE`、`BEIMING_APP`、`TMPDIR` 取路径，三种后端写法相同。Windows 的 `portable` 后端另带 `SystemRoot`（node 起得来要它，不是凭据），并把 libuv 会自动从父进程补的变量（`deps/uv/src/win/process.c` 的 `required_vars`）逐个盖掉：`USERPROFILE`、`HOMEDRIVE` 加 `HOMEPATH` 指向沙箱的 `HOME`，`TEMP`、`TMP` 指向专属临时目录，`USERNAME`、`USERDOMAIN`、`LOGONSERVER` 给中性值，`WINDIR`、`SYSTEMDRIVE` 照宿主机的（系统目录，不是凭据）。不盖的话宿主机的家目录和用户名会进作业的环境变量。盖掉的是变量的原值，不是路径前缀：专属临时目录建在宿主机的 `os.tmpdir()` 下面，宿主机临时目录在用户配置目录里时（Windows 默认是 `%LOCALAPPDATA%\Temp`，在用户配置目录下面），沙箱的 `HOME` 也建在它里面，作业从 `HOME`、`USERPROFILE`、`HOMEPATH`、`TEMP`、`TMP`、`TMPDIR` 的路径前缀里仍然看得到宿主机的目录结构和用户名。`portable` 只给本机调试用，对外服务一律走容器后端，容器里这些路径是 `/tmp`。这一条的渲染结果有单测，真 Windows 上只在 CI 里跑。

`runInWorkspaceSandbox` 交回 `{ backend, isolation, workspaceId, containerName, code, signal, timedOut, stdout, stderr }`。默认 10 分钟超时；标准输出与标准错误各只留前 8 Mi 个字符，多的丢掉。已经跑在别的 seatbelt 沙箱里时 `sandbox-exec` 起不来，探测会落到 `portable`。

### 预热池

`new WarmProcessPool({ size, spawn, destroy })`：`spawn()` 不带参数，预热时没有工作区可绑；`acquire(workspaceId)` 借出一个进程，`release()` 立刻销毁它并补一个新的，重复归还不重复销毁；`close()` 之后不再补。用过的进程不会回到池里。它只管进程的生命周期：`runInWorkspaceSandbox` 目前每个作业现起一个沙箱，没有接预热进程（容器起来之后加不了挂载，接法要等帧源常驻化时定）。

### 红队逃逸实测

`runSandboxRedTeam(options)` 搭一套夹具（两个工作区、一个模拟的宿主机家目录、一个只读引擎目录、宿主机回环上的监听端口、一个属于兄弟工作区的诱饵进程），把探针拷进引擎目录，在真实沙箱里逐项跑五类逃逸。判定在宿主机一侧做，不信探针自己的说法：读到的内容里有没有夹具埋的随机标记、监听端口收没收到连接、只读目录与沙箱外的文件变没变。探针对真实家目录只报条目数，报告里的本机路径换成占位符。

| 项 | 尝试 |
|---|---|
| `cross_workspace_read` | 绝对路径、`../` 相对路径、预先植入的文件与目录符号链接、列工作区根 |
| `host_home_and_secrets` | 模拟的 `.ssh/id_ed25519` 与 `.aws/credentials`、真实家目录及 `.ssh`、`.aws`、`.gnupg`、`.config`、环境变量里的密钥 |
| `external_network` | 宿主机回环端口的 TCP 与 HTTP、外网地址的 TCP、域名解析 |
| `cross_workspace_processes` | `ps`、`/proc/<进程号>/cmdline` 与 `environ`、0 号信号、用过的预热进程再分配后的内存残留 |
| `readonly_image_write` | 改写与新建引擎目录里的文件、在 `/var/tmp`、兄弟工作区、模拟家目录里新建文件 |

报告（`sandbox-redteam/0.1`）每项一条：`command`、`exitCode`（探针退出码：1 全部尝试失败，0 至少一次得手，3 连自己的工作区都读写不了）、`blockedBy`（拦截层）、`escaped`、`conclusive`、`blocked`、`hostEvidence`、`missingAttempts`、`receiptErrors`、`fixtureErrors`，以及每次尝试的载荷与实测错误码；顶层带 `backend`、`isolation`、`boundary`（后端边界）。

一项的结论有效（`conclusive`）要四样齐，缺一样这一项就判结论无效、整份报告判红：

1. 探针在自己的工作区里读写正常。
2. 回执完整并且和退出码自洽，不合格的记在 `receiptErrors`。每条子尝试的回执要是对象，带 `id` 和自有的布尔值 `ok`；说自己被拦（`ok: false`）的还要带非空字符串的错误码（`code` 或 `error`）。探针退出码要和明细对得上：明细全是被拦应是 1，有一次得手应是 0；对不上的（明细全拦却退出 0、被信号杀掉的 `null`、别的退出码）都不算数。
3. 上表里这一项的子尝试一个不少（判定方自己留着每项的 `expectedAttempts` 清单逐个核对，少的记在 `missingAttempts`）。
4. 攻击夹具都建起来并且活到最后，不合格的记在 `fixtureErrors`。例如 Windows 上没有建符号链接的权限时，两条软链尝试没有真打到靶子上。诱饵进程起来后先在标准输出上应一声 `ready`，宿主机确认它在才开跑；进程隔离那一项的探针跑完、清理诱饵之前，宿主机先看子进程状态和 0 号信号，再往诱饵的标准输入写一行 `ping`，等它回一行带本轮随机标记的 `pong`（最多等 2 秒）。写不进去、标准输出断了、收到退出事件、超时，哪一种都记成夹具失效。不靠等退出通知：Windows 上通知由线程池异步投回，等多久都有时间窗，进程号还可能被别的进程顶替；已经退出的、卡死的或顶替它的进程回不出这一行。诱饵中途退出的话，「看不到它」什么也说明不了。环境变量里的两个诱饵密钥挂在宿主机进程的 `process.env` 上，键名带本轮标记（`BEIMING_REDTEAM_<标记>_API_KEY`、`BEIMING_REDTEAM_<标记>_AWS_SECRET_ACCESS_KEY`）。标记是进程级递增的序号（挂在 `process` 上）加完整的 UUID，夹具目录和 `/var/tmp` 下的探测文件也用它；选键时实查 `process.env`，键已经在场就换下一个序号，选中即同步占位。同一进程内（含同一文件被加载成多份模块实例）重叠或交错的各轮诱饵键互不相交，UUID 相同也不相撞；调用方自己设的同名变量不会被选中，收尾时只删本轮的两个键。`host_home_and_secrets` 的探针开跑之前和跑完之后各核对一次两个键都是本轮的值，任一端缺失或被改写就记成夹具失效。

`blocked` 是结论有效并且没逃逸；`ok` 要五项都 `blocked`。命令行 `node beiming/jobs/sandbox-redteam.mjs [--json 文件] [--md 文件] [--backend 后端] [--image 镜像] [--allow-degraded]`：全拦 exit 0，有逃逸或结论无效 exit 4，没有可用后端 exit 3。默认的外网目标是 `1.1.1.1:443` 与 `example.com`，被拦时没有包发出去。

2026-11-22 在 macOS 27.2（arm64，Node 24.13.1）上用 `darwin-seatbelt` 后端实测，5/5 被拦：

| 项 | 探针退出码 | 各次尝试的实测错误码 | 逃逸 |
|---|---|---|---|
| `cross_workspace_read` | 1 | 五次都是 `EPERM` | 否 |
| `host_home_and_secrets` | 1 | 模拟密钥与真实家目录 `EPERM`（机器上没有的目录 `ENOENT`），环境变量 `STRIPPED` | 否 |
| `external_network` | 1 | 回环 TCP、HTTP 与外网 TCP `EPERM`，域名解析 `ENOTFOUND`，监听端口收到 0 个连接 | 否 |
| `cross_workspace_processes` | 1 | `ps` 与 0 号信号 `EPERM`，`/proc` `ENOENT`，预热进程 `CLEAN` | 否 |
| `readonly_image_write` | 1 | 五次都是 `EPERM`，引擎目录与沙箱外没有多出文件 | 否 |

`oci` 后端这次没有实测（这台机器上容器运行时没开）：规格渲染出的参数有单测，真跑容器的那一条测试要设 `BEIMING_SANDBOX_OCI_IMAGE`（带 node 的本地镜像名）才执行，否则显式跳过。Windows 上只有 `portable` 后端，它的红队报告如实判红。

测试里另有五个负向变异：放开网络、带进宿主机环境变量、多挂兄弟工作区、引擎目录挂成可写（这四个按改坏的规格真起 seatbelt 沙箱）、预热进程用后不销毁。每一个都被红队在对应那一项上判 `escaped: true`，前四个同时过不了 `validateContainerSpec`。

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
