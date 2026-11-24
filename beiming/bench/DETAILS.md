# 考题：细则

[README.md](README.md) 是索引；这里放跑题器的判分口径、隔离边界和落盘字段，[看板](#看板)的输入与口径，[成片墙、原话账本与盲选页](#成片墙原话账本与盲选页)的流程和隔离规则，以及[标准负对照核验](#标准负对照核验)的模型与判分口径。代码 [runner.mjs](runner.mjs)（隔离和观测复用 `tools/eval/lib`）、[board.mjs](board.mjs)、[wall.mjs](wall.mjs)、[negatives/level-1/run-b5-l1.mjs](negatives/level-1/run-b5-l1.mjs)、[negatives/level-2-a/run-b5-l2a.mjs](negatives/level-2-a/run-b5-l2a.mjs)、[negatives/level-2-b/run-b6.mjs](negatives/level-2-b/run-b6.mjs)，测试 `node --test beiming/bench/runner.test.mjs`（要真片的两条在没有 FFmpeg 的机器上跳过）、`node --test beiming/bench/wall.test.mjs`、`node --test beiming/bench/b5-negatives.test.mjs` 与 `node --test beiming/bench/b6-negatives.test.mjs`。

## 默认判分 `defaultJudge`

没传 `judge` 时用它。判分在宿主进程里做，只认宿主自己量到的；开跑前先查 `ffprobe`（可用环境变量 `FFPROBE` 指定），没有就 exit 3，不做题。

**成片怎么找**，按顺序取第一个：

1. `submission.json` 里 `video`、`deliverable`、`file` 点名的相对路径；
2. 做题目录里的 `deliverable.mp4`、`out.mp4`；
3. 做题目录里唯一的视频文件（`.mp4`、`.mov`、`.mkv`、`.webm`）；有两条又没点名，认不出成片。

解析掉软链后必须还是做题目录里的普通文件：绝对路径、`../`、指到外面的软链都不认。

**量什么**：`ffprobe` 解码数帧（不信容器里写的帧数），对题目的 `deliverable` 核宽、高、帧率（分子分母交叉相乘，精确比）、帧数、音轨（`audio` 是 `none` 时不得有音轨，否则必须有）。

| 项 | 怎么判 | `basis` |
|---|---|---|
| `delivery(...)` | 上面的实测全对，实参写了的宽、高、帧率、帧数再和实测逐个比 | `host` |
| `delivery.spec`、`deliver.spec` | 上面的实测全对 | `host` |
| `no_cut` | 规格对了才量：`observe` 的 `cutScene` 检切点，`verify` 的 `evaluateAssertion` 求值 | `host` |
| 别的谓词和指标 | 还没接量测器，一律不过 | `unmeasured` |

`submission.json` 是做题方写的，只读成片的相对路径和 `cost.gpuSeconds`（自报的开销，只拿来对预算），里面自报的过没过不看。所以没交片时成片相关的项全部不过。

还没核的：`delivery` 在谓词契约里还要色彩标签、黑帧和冻结，这里没查。带 `unmeasured` 项的题用默认判分过不了，结果里的 `unmeasured` 是这类项的条数；要判就传自己的 `judge({ question, worktreeDir, runDir })`，回 `{ metrics: { 指标名: true | { pass } }, predicates: { 断言原文: true | { pass } } }`，这时 `basis` 记 `judge`。

## 做题进程的隔离

做题进程和宿主是同一个系统用户，没有换用户，也没有容器。`observation.json` 的 `isolation` 记这次实际是哪一级：

| `isolation` | 什么时候 | 文件边界 |
|---|---|---|
| `seatbelt` | macOS，`/usr/bin/sandbox-exec` 实际能用 | 有，见下 |
| `process-cwd` | 别的平台，或 `sandbox-exec` 套不上 | 没有：只换了工作目录和环境变量，这个用户读得到的做题进程都读得到 |
| `in-process` | `solver` 是函数（测试和内嵌用） | 没有：和宿主同一个进程 |
| `none` | `expectedFail` 没实跑 | 没起做题进程 |

`seatbelt` 挡三样，别的照常放行：

- **原题**读不到。隐藏题在仓库外时，它所在的目录整个读不到（别的隐藏题、答案常放在一起）。所以隐藏题单独放一个目录，做题命令别放在里面；这个目录要是装着运行目录、家目录或 node，就只挡原题这一个文件。
- 运行目录里宿主写的 `meta.json` 读不到，`result.json`、`observation.json` 写不了（做题进程留下的后台进程也改不了结果）。
- **别的运行**（`<root>/<题号>/<runId>/` 往下，里面有别人交的成片）读不到内容；运行根里别的文件照常能读。

没挡的：网络（`--model` 那条路只在工具层禁了 `WebSearch`、`WebFetch`）、进程列表（看得到宿主命令行里的原题路径，读不到内容）、这个用户别的文件、给原题建的硬链接。

**环境变量**只传白名单，名字不分大小写：`PATH`、`HOME`、`USERPROFILE`、`SYSTEMROOT`、`COMSPEC`、`PATHEXT`、`LANG`、`LC_ALL`、`TERM`、`NODE_PATH`，加上指到运行目录里的 `TMPDIR`、`TMP`、`TEMP`、`CLAUDE_CONFIG_DIR`，以及 `PLAYWRIGHT_BROWSERS_PATH`。`--model` 时另传 `ANTHROPIC_*`、`CLAUDE_CODE_*`、`HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY`。 Windows 上 libuv 会把传入环境里缺的必选变量（`HOMEDRIVE`、`HOMEPATH`、`LOGONSERVER`、`SYSTEMDRIVE`、`USERDOMAIN`、`USERNAME`、`WINDIR` 等）从父进程补回来，所以跑题器一个不缺地自己填、名字一律大写：`SYSTEMROOT`、`WINDIR`、`SYSTEMDRIVE`、`COMSPEC`、`PATHEXT` 照宿主的，`PATH` 照宿主的、宿主没有就填 `%SYSTEMROOT%\System32`，`HOME`、`USERPROFILE` 指到做题目录，`HOMEDRIVE`、`HOMEPATH`、`USERNAME`（`bench`）、`USERDOMAIN`、`LOGONSERVER` 填固定的占位值，宿主的用户名和家目录不传。

**怎么算没做完**（`status` 是 `error`，产物写完了也一样）：做题命令退出码不是 0；被信号杀掉（没有退出码）；超过墙钟预算被结束；做题函数抛错（消息是空的也算）。没做完的运行不采信半截产物，也不再调判分器：`score` 记 0，`assertions` 是空数组，`artifacts` 照记，开销里的 `gpuSeconds` 只认做题函数自己回的。做完了但判分器抛错同样落 `error`。失败原因在 `result.json` 和 `observation.json` 的 `error` 里各记一份、是同一句非空文字（没出错是 `null`）；隐藏题不写报错原文：做题函数抛错只写「做题出错」，判分器抛错只写「判分出错」，超时不写预算数值。做题、判分抛的错里只有环境缺失（`EvalError`，错误码是 `env.` 加点分的短横线小写段，如 `env.ffmpeg-missing`、`env.media.probe-missing`）往上抛、按退出码 3 报出、不落结果；隐藏题的只留错误码，抛出的消息就是错误码本身，不带原因和原提示（开跑前查 `ffprobe`、做题命令启动不了也是这个口径）；别的结构化错误（如 `contractError`）和普通报错一样记成 `error` 并落盘。

## 落盘

运行目录 `<root>/<题号>/<runId>/` 下有做题目录 `worktree/`、隔离会话配置 `session/`、做题进程的临时目录 `tmp/`、会话记录 `transcript/`。

`result.json`（`bench-result/0.1`）给看板读：

| 字段 | 说明 |
|---|---|
| `questionId`、`level`、`source`、`model`、`runId` | 哪道题、谁做的 |
| `status` | `pass`（逐项全过且没超预算）、`fail`、`error`、`expected-fail` |
| `pass` | 布尔，一定有：`status` 是 `pass` 才是 `true`，`fail`、`error`、`expected-fail` 都是 `false` |
| `score` | 过了的评分项权重之和；`error`、`expected-fail` 是 0 |
| `error` | 没出错是 `null`；`status` 是 `error` 时是失败原因（非空，和 `observation.json` 的 `error` 相同） |
| `visibility` | `public` 或 `hidden` |
| `blockedBy` | 题目的阻塞原因；隐藏题只写 `["[hidden]"]` |
| `unmeasured` | 没有量测器的项数（`error`、`expected-fail` 没有逐项，是 0） |
| `assertions` | 逐项 `{ kind, name, weight?, pass, basis }`；隐藏题、`error`、`expected-fail` 是空数组 |
| `cost`、`overBudget` | `tokens`、`turns`、`toolCalls`、`wallMs`、`gpuSeconds`；超了预算的字段名 |
| `artifacts`、`createdAt` | 做题目录里的产物（路径、字节数、哈希）；落盘时刻 |

`observation.json` 记做题方式、`isolation`、退出码、是否超时、出错原因、开销和会话记录的文件名；`meta.json` 记题号、原题哈希、平台和开始时刻。运行目录里不放原题、原题路径和判分细节。

隐藏题另外不回显：逐项的指标名和断言原文、`blockedBy` 的原文、超时信息里的预算数值。校验不过的报错只说类别和处数。

## 看板

代码 [board.mjs](board.mjs)，测试 `node --test beiming/bench/board.test.mjs`。三个公开函数都是纯函数：不读墙钟、不读文件，日期由调用方给；回的是深冻结的新数据，不改入参。

```sh
node beiming/bench/board.mjs build --out-dir <目录> [--as-of <YYYY-MM-DD>] [--questions-dir <目录>] [--results-dir <目录>] [--ledger <ledger.jsonl>] [--cards-dir <目录>] [--priors <文件,…>] [--extra <文件>]
```

写出 `<目录>/board.json`（`bench-board/0.1`）、`history.json`（每天一行，目录里已有的接着记）、`index.html`，标准输出是一行 JSON 摘要。三份都算出来才落盘；入参不合规 exit 2，题目没过 `validateQuestion` exit 4，都不写文件。`--as-of` 不写时只有命令行外壳取一次 UTC 当天。`--results-dir` 递归找 `bench-result/0.1`，跳过做题方能写的 `worktree/`、`session/`、`tmp/`、`transcript/`，每份结果连同报错原文、产物清单、逐项断言一起过泄露门禁，再提取看板字段。`--cards-dir` 接受 `card.json` 和声明 `card/0.1` 的 JSON 文件。`--extra` 是一个 JSON 对象，放下表里没有专门参数的那几项。

### 入参 `buildBoard(inputs)`

只有 `asOf` 必填，其余没给就是没有数据。不认识的顶层键拒收。

| 键 | 内容 |
|---|---|
| `asOf` | 看板是哪一天的，`YYYY-MM-DD` |
| `questions` | 题目文件（`question/0.1`）。读 `id`、`level`、`title`、`needs`、`flags.hidden`、`flags.expectedFail`、`calibration` 的 `version`、`status`、`updatedAt` |
| `results` | `bench-result/0.1`。读 `questionId`、`level`、`source`、`model`、`status`、`score`、`visibility`、`unmeasured`、`createdAt`，另认 `unsupported: true` |
| `cards` | 卡文件：`id`、`kind`、`livesIn`、`exams`、逐环境的 `status`（`level`、`date`）。也收写好的 `status` 字符串加 `reproducedAt` 或 `statusUpdatedAt` |
| `sourceCapabilities` | `{ 帧源: { unsupportedQuestions: [题号], unsupportedCards: [卡名] } }` |
| `ledger` | A15 账本的行（`job-ledger/0.1`） |
| `jobs` | 作业记录 `{ jobId, basePass, interventions, filmDurationSec?, templateOrigin?, mode?, selfSelectedTemplate? }` |
| `parity` | 对拍读数 `{ id, margin }`，或 `{ id, value, threshold, direction: 'at-least' \| 'at-most' }` |
| `energy` | 能量尺子读数 `{ metric, value }`，只认 `noise.residual`、`clip.highlight-ratio`、`alias.edge` |
| `blindPicks` | 盲选记录 `{ outcome: 'win' \| 'tie' \| 'loss' }` |
| `pureFunctionGate`、`locality`、`rebuild.exact`、`rebuild.tolerance`、`rebuild.nightlyLegacy` | 逐条的 `[{ pass }]`，或数好的 `{ passed, total }`；没给记 `not-run` |
| `priors` | 先验表（`priors/0.1`，带 `entries`）或单条先验 |
| `packParity` | `{ verifiedPacks, ablatedSwitches }`（分母固定为 5 和 56；若写 `totalPacks`、`totalSwitches` 必须等于 5 和 56） |
| `harvest` | `{ drafted, promoted, archived, reproducedPromotions }` |
| `history` | 之前的每日行（`history.json` 的内容） |
| `scoreboardMetric` | B11 第 5 步自然周重复打回率 `{ firstTimeCount, repeatCount, total, repeatRate, weekStart?, weekEnd? }` |
| `frameMeta` | O12 每帧宿主元数据列表：支持按片型分组 `[{ filmType, filmId?, frames: [{ source: { renderer } }] }]` 或单帧直接携带 `filmType` 的 `meta/0.1` 对象 `[{ filmType, source: { renderer }, ... }]`（仅认每帧 `source.renderer`，`filmType` 须在 `FILM_TYPES` 内，`renderer` 须在 `ALLOWED_RENDERERS` 内） |

### 矩阵

行按等级、题号升序排列。列是结果里出现过的（帧源，做题模型）组合，省略的帧源或模型记为 `unspecified`。同一格跑过多次时取 `createdAt` 最新的结果。时间戳须含时区（`Z` 或 `±HH:MM`），比较时保留小数秒精度。有时间戳的结果优先于缺省时间的旧记录，时刻相同或都缺省时取输入中靠后的记录。

| `kind` | 什么时候 | 进均分 |
|---|---|---|
| `unsupported-capability` | 结果的 `status` 是它或带 `unsupported: true`；能力表点了这道题或它要的卡；`needs` 里有一张卡只落在别的帧源上（`livesIn` 全是 `source:` 开头且没有这个帧源，`data`、`comp` 这类落点算跨帧源） | 不进 |
| `unrun` | 这一格没有结果 | 不进 |
| `scored` | 其余。做题出错、超时、判分失败、预期失败、0 分都在这里 | 进 |

缺能力的格 `display` 和 `unsupportedReason` 字面是「这个帧源没有这项能力」，`score`、`pass` 是 `null`，哪怕那一格有成绩。行均分 `rowMean`、列均分 `columns[].mean`、`sourceMeans`、`modelMeans`、`overallMean` 和按等级的通过率只数 `scored` 的格，分子分母都不含另外两种；一格都没有时是 `null`。

隐藏题（题面或结果任一处标了隐藏）的行只有题号、等级、各格的总分和状态，`title` 写成「隐藏题 题号」；题面、`needs`、`refs`、`blockedBy`、逐项都不出，也不进「考题覆盖」的逐题表。预期失败的题行上 `expectedFail: true`，没强跑的那格 `status` 是 `expected-fail`、记 0 分。题目的 `calibration.updatedAt` 等于 `asOf`，或版本、状态和前一天历史里记的不一样，行上 `calibrationChanged: true`，并记进 `calibrationChanges`。

### 四个指标 `fourIndicators`

- `ceiling`：`passRateByLevel`（1 到 5 级，`{ passed, total, rate }`）、`parityHeadroom`（余量是实测值离门限多远，正的在门限内；交最小余量和门限外的项数）、`energyRulers`（每把尺子的读数个数、均值、最差值）、`blindPick`（赢、平、负与赢或平的占比）。没给的是 `null`。
- `unattended`：基础谓词全过且人工介入 0 次的作业占比。`templateOrigin` 是 `self-selected`，或 `mode` 是 `hand` 且 `selfSelectedTemplate` 是 `true` 的片单列在 `selfSelected`，不进主统计。
- `speedAndCost`：账本先过 A15 的 `summarizeJobLedger`。出了成片的作业是有一轮 `succeeded` 且成片时长大于 0 的（时长取作业记录的 `filmDurationSec`，账本行自己带了也认）；它的每一轮都摊在成片秒数上，得 `wallSecPerFilmSec`、`gpuSecPerFilmSec`、`tokensPerFilmSec`、`tokensByTierPerFilmSec`。`renderedPerDelivered` 是全账本的渲帧数除以交付帧数，`meanRounds` 是每个作业平均几行。没有成片时比率是 `null`；有的行显卡秒不是实测时 `gpuIsLowerBound` 是 `true`。
- `controllability`：`pureFunctionGate`、`locality`、`rebuild` 的 `exact`（同机比哈希）、`tolerance`（跨机容差）、`nightlyLegacy`（旧作品夜间重建）。

### 核心出帧占比 `coreFrameShare`（O12）

导出常量 `FILM_TYPES`（深冻结，固定四类片型：`motion-explainer` 动态图形与讲解、`hard-surface` 硬表面与写实、`toon` 三渲二、`realtime-3d` 游戏感实时三维）与 `ALLOWED_RENDERERS`（`['blender', 'three', 'core', 'legacy-page']`），并由 `beiming/bench/index.mjs` 重新导出。

- `buildBoard` 始终输出 `coreFrameShare: { overall: { coreFrames, totalFrames, rate }, byFilmType }`，其中 `byFilmType` 固定包含 `FILM_TYPES` 四格（每格含 `label`、`coreFrames`、`totalFrames`、`rate`）；无帧时 `coreFrames = 0`、`totalFrames = 0`、`rate = 0`（而非 `null`），接管过门前四格照样完整输出与渲染。
- 唯一真相源是逐帧 `source.renderer === 'core'`（支持按片型分组 `frameMeta[].frames[]` 或单帧直带 `filmType` 两种形态）：严格校验 `filmType`、`frames` 数组（分组形态）、`source` 对象与 `source.renderer` 取值，允许保留标准 `meta/0.1` 的其余字段；作业记录 `jobs` 或条目上的任何自报字段一律忽略，绝不采信。
- `renderBoardHtml` 在「四个指标」与考题矩阵之间渲染独立的「核心出帧占比」区块，按 `FILM_TYPES` 固定顺序逐格展示片型名、占比（以精确整数半进位保留一位小数百分比，如 `0.0%`、`0.2%`、`25.0%`，无浮点舍入漂移）与帧数（`coreFrames / totalFrames 帧`）及四片型总计；未含 `coreFrameShare` 的旧看板快照按全 0 兜底展示，篡改后的 `coreFrameShare` 由 `checkBoard` 拒收。命令行可通过 `--extra` 传入 `frameMeta`。

### 整合进度 `integrationProgress` 与反向指标 `reverseIndicators`

卡的状态取各环境里最高的一级，对到看板的叫法：`read` 是 `read-only`（只读过），`reproduced`，`measured` 是 `verified`，`film-verified` 是 `production-proven`；`ext` 的 `registry.candidate` 是 `true` 的记 `candidate`。

- `cards`：`distribution` 按类别 × 落点 × 状态（一张卡有几个落点数几次）；`reproducedOrAbove`、`verifiedOrAbove`、`productionProven` 不含只读过的占位卡和候选卡，这两种单独记在 `readOnlyPlaceholders`、`candidates`。
- `examCoverage`：`perQuestion` 是每道公开题 `needs` 里到 `verified` 及以上的比例（不要卡的题标 `noCardNeeds`）；`cardsWithExam` 是 `reproduced` 及以上的卡里挂了题的占比；`scorableQuestions` 是没登记成预期失败、也没有缺量测器的项的题数。
- `priorsVerified`：`verifiedInOurStack` 是 `true` 的明细条数除以 4452（`TOTAL_PRIORS_BASELINE`）。带 `summaryOf` 的汇总行不数，同一个 `id` 只数一次。
- `packParity`：过了确定性验收的包数比 5，跑过消融的开关数比 56。`harvest`：起草、晋升、归档、走到复现过的候选数。
- `expectedFailQuestions`：预期失败题的数量和题号。
- `staleReproducedCards`：停在 `reproduced` 且从到这一级最早那天到 `asOf` 超过 14 天的卡（正好 14 天不算）。只读过的占位卡和候选卡放多久都不算；没写日期的列在 `undated`。
- `scoreboardMetric`（可选入参，命令行也可经 `--extra` 传入）：接入 B11 第 5 步 `computeWeeklyRejectionStats` 产出的自然周重复打回率 `{ firstTimeCount, repeatCount, total, repeatRate }`（可选带 `weekStart` / `weekEnd`），经计数与比率一致性校验后随看板落盘并在静态页「反向指标」区渲染周重复打回率。

### 历史、静态页与门禁

`history` 每天一行（计分格数、总均分、各级通过率、无人值守率、每秒成片墙钟秒、卡数、参数验证比例、两个反向指标、当天各题的校准），同一天重跑覆盖当天那行，按日期升序。`appendBoardHistory(history, board)` 做同一件事，回新数组。

`renderBoardHtml(board)` 回一份自包含的 HTML：样式内联，没有脚本、外链和网络资源，带 `default-src 'none'` 的内容安全策略；插进去的文字全部转义 `& < > " '`。

三个函数的入参先抄成纯数据再用：Proxy、取值器、Symbol 键、不可枚举属性、类实例、`__proto__` 键、有空洞或带附加属性的数组、非有限数、环一律抛 `code` 是 `usage.bad-argument`（`exitCode` 2）的 `TypeError` 或 `RangeError`，校验时不调取值器、不触发 Proxy 陷阱。抄好的数据整份过 `scanQuestionLeaks`（看板不读的字段也扫），命中同样拒，报错只带类型和位置。

## 起草形态

`normalizeQuestionDraft(draft)` 把起草写法（YAML 读成的对象）换成 `question/0.1`，只换不校验：下划线键改小驼峰（到 `scoring[].args` 第一层为止，`assets`、`ext` 里的不动），`width`、`height` 并成 `size`，整数 `fps` 写成 `"n/1"`，`wall_s`（秒）换成 `wallMs`，`gpu_s` 换成 `gpuSeconds`，`初值未校准` 换成 `uncalibrated`，`metric:` 前缀去掉。新旧键并存（`size` 和 `width`）不覆盖，留给校验报错；一个键两种拼法并存或草稿不是纯数据抛 `TypeError`。

## 成片墙、原话账本与盲选页

代码 [wall.mjs](wall.mjs)（由 `index.mjs` 重导出），测试 `node --test beiming/bench/wall.test.mjs`。构建与计分函数不读墙钟、不调 `Math.random`，日期与带时区的 ISO-8601 时间戳由调用方显式传入。入参须为普通 JSON 对象与数组（不防调用方自造的 `Proxy` 或取值器），非法参数统一抛 `code` 为 `usage.bad-argument`（`exitCode` 2）的 `TypeError` 或 `RangeError`。三张 HTML 页面全部离线自包含（零外链，带 `default-src 'none'` 内容安全策略，内联交互脚本零动态插值），所有动态文本经 `escapeHtml` 转义；媒体路径只收相对路径或受控路由前缀（`/api/`、`/artifacts/`、`/media/`、`/blind/`、`/wall/`、`/films/`、`/refs/`），拦截 `..`（含多重百分号编码与查询串）、反斜杠、协议头（`http:`、`https:`、`javascript:`、`data:`、`file:` 等）、`//` 外链、盘符与宿主系统绝对路径。

### 每日成片墙 `buildFilmWall` / `renderFilmWallHtml`

- `buildFilmWall({ date, films, scoreboard, unmeasurableDimensions, maxDaily = 5, includeAllFailed = true, seed })` 回深冻结的 `bench-wall/0.1` 快照：过滤出当天的成片；`includeAllFailed` 为真时保留全部 `ok === false` 的失败片，并按 `seed` 的 SHA-256 摘要从成功片里确定性抽样至多 `maxDaily` 条。
- 每条成片带并排参考（`reference: { mediaUrl, label, kind }`）、与 `board.mjs` 四数同口径的 `fourIndicators`（`ceiling` 含考题通过率、盲选、对拍余量与 `energyRulers` 能量尺读数，`unattended`，`speedAndCost`，`controllability` 含纯函数门、局部性、同机重建、`rebuild.tolerance` 跨机容差与夜间重建；缺数据时 `value` 为 `null`、`display` 为 `暂无`）、按 `template` 与通配 `*` 匹配的 `unmeasurableDimensions`，以及审核状态（`pending` / `approved` / `rejected`）。
- `renderFilmWallHtml(wall)` 输出单页中文静态 HTML，并排展示今日成片与参考媒体、四个核心指标、判不了的维度，以及离线导出回执的「过 / 一句话打回」操作区（回执自带 ISO-8601 `at`，可直接交给 `recordRejection` 入账）。

### 原话账本与五步流程

账本目录 `ledgerDir` 在 `withFileLock` 互斥锁下以追加日志 `events.jsonl` 为唯一事实源（第 4 步另追加 `reads.jsonl`），每次变更同步原子刷新 `entries.json`、`predicate-additions.json`、`unmeasurable-dimensions.json`、`weekly-stats.json`；`loadLedgerState(ledgerDir)` 从磁盘重放并返回 `bench-rejection-ledger/0.1` 快照，`renderLedgerHtml(ledgerState)` 渲染无脚本离线静态页。

1. `recordRejection(ledgerDir, { filmId, template, frames, verbatim, category, author, at })`：核验帧区间 `[start, end]`（`0 <= start <= end` 的安全整数）与非空原话后，将 `verbatim` **一字不改**写入账本，回 `step: 1` 条目（`rej-0001` 起顺序编号）。
2. `translateRejection(ledgerDir, entryId, { candidatePredicate, missedLayer, rationale, reviewer, at })`：记录候选谓词并必填 `missedLayer`（仅限 `'L1'..'L5'`），时间戳不得早于第 1 步，推进至 `step: 2`。
3. `confirmRejectionTriage(ledgerDir, entryId, { decision, template, predicate, dimension, reason, category, curator, at })`：要求已完成第 2 步。`decision === 'add-predicate'` 时调用 `beiming/verify/predicates.mjs` 的 `checkExtra` 对登记表与参数语法做正式校验（未登记、语法错误、含引号外分号或 `planned` 未实装谓词一律拒绝且不落盘），通过后按 `(template, predicate)` 去重写入基础谓词增补表；`decision === 'unmeasurable-dimension'` 时按 `(template, dimension)` 去重登记为人工把关维度，推进至 `step: 3`。
4. `recordLedgerRead(ledgerDir, { filmId, template, reader, at })`：下一部同片型作品开工前按 `template`（含 `*`）检索相关打回原话、增补谓词与判不了的维度，追加不可遗漏的 `readRecord`（`read-0001` 起），已过第 3 步的相关条目推进至 `step: 4`。
5. `computeWeeklyRejectionStats(ledgerDir, { weekOf })`：按 `entry.at` 时间戳写明的日历日期归入自然周（周一至周日），按 `category`（缺省依次回退裁定谓词、维度、候选谓词、原话）统计 `totalRejections`、`uniqueCategories`、`repeatedRejections`（同类超出首次的重复次数 `max(0, count - 1)` 之和）与 `repeatRate`，幂等更新该周快照并将已过第 4 步的周内条目推进至 `step: 5`，产出的 `scoreboardMetric` 可直接交给 `buildBoard` 接入 B9 看板展示。

### 盲选页 `createBlindSession` / `renderBlindPageHtml` / `recordBlindBallot` / `unblindBlindSession`

- `createBlindSession({ sessionId, purpose, pairs, decisionLine, createdAt, seed })`：支持约 10 组（U7 同等画面）至 30 组以上（核心接管）的静帧（`still`）或短片段（`clip`）。前置判定线 `decisionLine` 必填且 `committedAt <= createdAt`，支持 `minTargetWinsOrTies` / `minCandidateWinsOrTies` / `minWinsOrTies` 门槛。显式传入 `seed` 时按 `(seed, sessionId, pairIndex)` 的 SHA-256 最低位确定性分配每组 `left` / `right` 槽位；省略 `seed` 时由 `crypto.randomBytes(16)` 生成不可预测随机种子（仅写入 `answerKey.seed`，绝不退回公开 `sessionId` 也不写入 `publicSession`）。返回严格隔离且以规范 `sha256:` `layoutDigest` 互相绑定的 `{ publicSession, answerKey }`。
- 零泄露门禁：`publicSession`（`bench-blind-public/0.1`）只保留中立编号 `pair-01` 与槽位 `pair-01-L` / `pair-01-R`，剔除 `targetSource`、原始 `pair.id`、双方 `source` / `label` 与审片选择；`createBlindSession` 与 `renderBlindPageHtml` 对公开字段与媒体路径做循环百分号解码（容错非法 `%`）+ NFKC 归一扫描，命中任何候选来源名、标签或内置来源词（`beiming`、`北冥`、`cycles`、`blender`、`reference`、`gpt` 等）即拒收；盲选页标题与正文全部中立（不含「北冥」字样），导出的选票 JSON 自带 ISO-8601 `submittedAt` 与 `layoutDigest`。
- `recordBlindBallot(ballotStore, publicSession, { sessionId, layoutDigest, voter, votes, submittedAt })`：校验 `ballot.sessionId` 与 `ballot.layoutDigest`（提供时必须与当前会话完全一致，禁止跨会话静默覆写）、核验每组投票仅限 `'left' | 'right' | 'tie'` 且不重不漏、强制校验 `submittedAt >= decisionLine.committedAt`（按纪元纳秒精确比较），向受控目录追加写入 `ballots.jsonl`（或推入内存数组），回 `bench-blind-ballot/0.1`。
- `unblindBlindSession(publicSession, answerKey, ballot)`：核对会话、`answerKey.layoutDigest` 与公开槽位现算 `layoutDigest`（禁止同场重排后用旧答案键静默揭盲）及判定线一致后揭盲，回 `bench-blind-report/0.1`：汇总双方胜出数、`ties`、`targetWinsOrTies`、U7 判定 `passed`（`targetWins + ties >= minWinsOrTies`）及可直接传入 `buildBoard({ blindPicks })` 的 `boardBlindPicks`；提供 `reviewerChoice`（或 `reviewerPerspectives`）时计算审片与人类一致率 `agreementRate`，当 `agreementRate < 0.6` 时置 `disablePerspective: true`（恰为 `0.6` 保留）。

## 标准负对照核验

代码 [negatives/level-1/run-b5-l1.mjs](negatives/level-1/run-b5-l1.mjs)（B5 第一部分，覆盖 B2 一级四题 `01-1`、`23-1`、`28-1`、`29-1` 共 12 份夹具）、[negatives/level-2-a/run-b5-l2a.mjs](negatives/level-2-a/run-b5-l2a.mjs)（B5 第二部分，覆盖 B3 二级第一批四题 `23-2`、`27-1`、`29-2`、`30-1` 共 12 份夹具）与 [negatives/level-2-b/run-b6.mjs](negatives/level-2-b/run-b6.mjs)（B6，覆盖 B4 二级第二批四题 `5-1`、`18-1`、`18-2`、`15-2` 共 12 份夹具），测试 `node --test beiming/bench/b5-negatives.test.mjs` 与 `node --test beiming/bench/b6-negatives.test.mjs`。

- **夹具契约（`bench-negative/0.1`）**：每份夹具固定九栏 `format`、`id`（`<题号>-<种类>`）、`questionId`、`kind`（`disable-card`、`shift-2f`、`random-beats`）、`disabledCards`（`disable-card` 点名题面 `needs` 里关掉的卡，另外两类为空数组）、`seed`（`random-beats` 必填安全整数种子，另外两类为 `null`）、`description`、`perturbation`、`expectedFailedMetrics`（`[{ scoring, metric, why }]`，下标与指标名对齐题面 `scoring[]` 且不重复）。全部夹具与核验代码均通过 `scanQuestionLeaks` 及专名门禁扫描。
- **真实量测与正式判分**：每道题由参数化合成信号/行为模型在题目 `deliverable` 时间线上现造信号，经真实检测器（原始像素帧间 YDIF > 24 与 `observe` 的 `telemetry` 双重交叉校验切点、`layoutEdges`、`loopClosurePsnr`、`pixelBbox`，48 kHz 立体声合成 PCM 的 ITU-R BS.1770-4 K 加权积分响度与 4 倍过采样真峰值实测、10 毫秒对数均方根音量跳变起音检测、拍点网格估计、逐帧黑帧/冻结/重复帧检测，以及 `cards/time/timeline/evaluate.mjs` 的时间线行为重求值）提取读数，再交给各自正式评估器（`evaluate-b2.mjs`、`evaluate-b3.mjs`、`evaluate-b4.mjs`）判分并逐帧如实求值基础谓词（不跨帧复用不同几何的 `meta`；随机拍点采用确定性 O(count) Floyd 无放回抽样）。`30-1` 严格遵守 2026-11-23 管理员裁定，只做 `80 -> 96` BPM 纯行为重求值检查（与 `evaluate-b3.mjs` 的 `read30_1` 逐位一致），零源码静态扫描。
- **入口与隔离**：`buildPositiveBaseline(questionId)` 验证默认参数正对照满分通过（`pass === true`、`score === 1`）；`evaluateNegativeControl(controlOrId)` 先过 `validateNegativeControl` 严格校验类型、登记的卡与故障参数（禁止种类互相冒充），再核验 `verdict.pass === false`、`verdict.score < 1` 且 `failedAsDeclared === true`（实际失分项与 `expectedFailedMetrics` 一一对应且读数留有该类故障痕迹）；`evaluatePerturbedModel(questionId, perturbation, seed)` 供撤销改动、反向错位与换种子实验使用。每次调用返回深拷贝的参数与读数，原地篡改返回值不影响后续核验。

