# 考题：细则

[README.md](README.md) 是索引；这里放跑题器的判分口径、隔离边界和落盘字段。代码 [runner.mjs](runner.mjs)，测试 `node --test beiming/bench/runner.test.mjs`（要真片的两条在没有 FFmpeg 的机器上跳过）。

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

**环境变量**只传白名单，名字不分大小写：`PATH`、`HOME`、`USERPROFILE`、`SYSTEMROOT`、`COMSPEC`、`PATHEXT`、`LANG`、`LC_ALL`、`TERM`、`NODE_PATH`，加上指到运行目录里的 `TMPDIR`、`TMP`、`TEMP`、`CLAUDE_CONFIG_DIR`，以及 `PLAYWRIGHT_BROWSERS_PATH`。`--model` 时另传 `ANTHROPIC_*`、`CLAUDE_CODE_*`、`HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY`。

**怎么算没做完**（`status` 是 `error`，产物写完了也一样）：做题命令退出码不是 0；被信号杀掉（没有退出码）；超过墙钟预算被结束；做题函数抛错。没做完的运行不采信半截产物：`score` 记 0，`assertions` 是空数组，`artifacts` 照记。

## 落盘

运行目录 `<root>/<题号>/<runId>/` 下有做题目录 `worktree/`、隔离会话配置 `session/`、做题进程的临时目录 `tmp/`、会话记录 `transcript/`。

`result.json`（`bench-result/0.1`）给看板读：

| 字段 | 说明 |
|---|---|
| `questionId`、`level`、`source`、`model`、`runId` | 哪道题、谁做的 |
| `status` | `pass`（逐项全过且没超预算）、`fail`、`error`、`expected-fail` |
| `score` | 过了的评分项权重之和；`error`、`expected-fail` 是 0 |
| `visibility` | `public` 或 `hidden` |
| `blockedBy` | 题目的阻塞原因；隐藏题只写 `["[hidden]"]` |
| `unmeasured` | 没有量测器的项数（`error`、`expected-fail` 没有逐项，是 0） |
| `assertions` | 逐项 `{ kind, name, weight?, pass, basis }`；隐藏题、`error`、`expected-fail` 是空数组 |
| `cost`、`overBudget` | `tokens`、`turns`、`toolCalls`、`wallMs`、`gpuSeconds`；超了预算的字段名 |
| `artifacts`、`createdAt` | 做题目录里的产物（路径、字节数、哈希）；落盘时刻 |

`observation.json` 记做题方式、`isolation`、退出码、是否超时、出错原因、开销和会话记录的文件名；`meta.json` 记题号、原题哈希、平台和开始时刻。运行目录里不放原题、原题路径和判分细节。

隐藏题另外不回显：逐项的指标名和断言原文、`blockedBy` 的原文、超时信息里的预算数值。校验不过的报错只说类别和处数。
