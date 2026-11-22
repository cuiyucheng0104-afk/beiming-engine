# 作业

管理作业调度、缓存、资产库和账本。

通过契约接收协议组件的作业请求，并交接作业输入与产物。跨组件通过契约交接，引用旧目录须命中白名单。

业务契约：[片子描述](../kernel/contracts/film/CONTRACT.md)（作业输入）、[锁文件](../kernel/contracts/lock/CONTRACT.md)（种子、版本与哈希，缓存与复跑按它对齐）。

通用约定见[契约目录](../kernel/contracts/)、[契约写法约定](../kernel/contracts/CONVENTIONS.md)和[目录归属契约](../kernel/contracts/ownership/CONTRACT.md)。

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
- **磁盘采样**在清理本轮中间产物前完成。`measureDiskBytes(dir)` 要求调用方传入可信根目录，递归时会跳过目录中的符号链接子项。汇总对磁盘取峰值 `maxDiskBytes`，对其余成本求和。
- **崩溃恢复**以原子落盘的 `job.json` 终态事件为准（WAL）。事件先保存这一轮的成本，随后队列追加账本。`queue.readLedger()`、`queue.summarizeLedger()`、`queue.replay(id)` 和显式调用 `queue.reconcileLedger()` 都会按 `(jobId, attempt)` 补齐已有结算载荷的缺行。旧作业缺少载荷时保留原有记录。
- **执行器怎么回报**：成功时在返回值里带 `cost`，失败时把 `cost` 挂在抛出的错误上（`throw Object.assign(new Error('渲染失败'), { cost })`）。`cost` 可以有 `gpuSeconds` 或 `frameMetas`（每帧 `timing.renderMs`，两样都给时用 `gpuSeconds`）、`tokensByTier`、`renderedFrames`、`deliveredFrames`，也可以用 `wallMs`、`diskBytes` 覆盖队列自己的实测。没回报的维度记 0。
- **`gpuKnown` 口径**：回报了 `gpuSeconds` 或 `frameMetas` 是 `true`；都没回报时 `gpuSeconds` 记 0、`gpuKnown` 是 `false`，表示「没有实测」而不是「没用显卡」。汇总里的 `gpuUnknownRows` 不为 0 时，显卡秒合计只是下限。`beiming/api/` 的执行器目前不回报 `cost`，它们的行就是这种情况，显卡秒仍在旧 API 账本里。
- **幂等与新轮次**：同一个 `(jobId, attempt)` 只记一次，重复结算（崩溃后重放、调用方重试）读回已有的那一行，不再追加。`queue.replay(id)` 开的是新一轮，`attempt` 加一，确实又花了一次钱，所以记新行。排队中取消、重放时补记的中断也各记一行，没有执行时间的墙钟是 0。
- **记账失败**时作业照常到终态，终态事件用 `ledgerError` 记录原因。执行器省略 `cost` 或传 `undefined` 均按缺省成本结算。显式 `null`、`Map` 等非法 `cost` 或非法 `tokensByTier` 会使本轮无法结算。账本故障不阻止 `replay` 执行新轮次；读账、汇总和显式补账仍会报错。若成本有效但追加时遇到账本损坏或等锁超时，载荷保留，故障排除后可自动补账。`ledgerError` 是当时的诊断，不代表现在仍缺行。
- **坏数据**：写入与读回过同一套校验。坏入参不落盘；读到坏行（不是合法 JSON、缺字段、字符串型数字、未知档位）报「第 N 行损坏」，N 是文件里的物理行号。
- **旧 API 账本**：`beiming/api/` 写的 `<数据目录>/meta/<片子>.ledger.jsonl` 是另一种行。默认严格模式不认它；用 `readJobLedger(file, { allowLegacyApiRows: true })`（`summarizeJobLedger` 同样接这个选项）读时，作业终态行映射成同样的六维并标 `legacyApiRow: true`，请求流水行与钩子行跳过。旧行的 token 不分档，`tokens` 与 `modelTokens` 都归进 `other`；没有的维度（交付帧数、磁盘字节）是 0。

从仓库根目录运行 `node --test beiming/jobs/ledger.test.mjs` 可自检账本。下面的示例假定 `workspaceDir` 已包含有效的 `film.json` 和镜头输入。

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
