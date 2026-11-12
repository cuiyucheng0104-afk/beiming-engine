# 命令约定与命令清单

读者｜写命令、调命令、编排命令的人与 agent　状态｜生效（附录 C1–C3 的冻结稿）　实现｜[tools/lib/cli.mjs](../tools/lib/cli.mjs)、[tools/lib/cli.py](../tools/lib/cli.py)　契约测试｜`node --test tests/cli tests/governance`

仓库里每个命令都按本页的同一套规则接参数、报错、退出、输出机器可读结果。新命令一律用 `tools/lib/` 的命令约定库写（用法见 [tools/lib/README.md](../tools/lib/README.md)）；老命令在第 9 节的清单里逐个改造，改造前它们的 `--help` 可能有副作用，先看清单再调。

## 1. 退出码

| 码 | 含义 | 典型情形 |
|---|---|---|
| 0 | 成功 | 也包括「只有提示、没有错误」 |
| 1 | 运行失败 | 页面异常、着色器错误、上下文丢失、编码失败、读写失败、工具内部错误 |
| 2 | 用法错误 | 未知选项、缺参数、非法数值、多余的位置参数、目标已存在 |
| 3 | 环境或依赖缺失、不合格 | 缺运行时、缺 Python 包、缺 FFmpeg、要求 GPU 却落到软件渲染 |
| 4 | 契约、验收或闸门不通过 | 页面契约、帧数或规格不符、QA 硬门失败、仓库规范检查有错误、模版不合格、拒绝终渲 |
| 5 | 资源忙 | 输出锁、渲染槽位、共享 GPU 被占 |
| 124 | 超时 | |
| 130 / 143 | 收到 SIGINT / SIGTERM，已清理 | 子进程、临时目录、分段文件都已收拾 |

编排器只按退出码分支，不解析报错文字。退出码表改动前先改本页，再通知所有命令的属主。

## 2. 输出

- **stdout 只放结果**：普通模式下是给人看的结果；加 `--json` 时 stdout **只有一个 JSON 对象**（信封），成功、失败、用法错误都输出。
- **stderr 放日志**：进度、警告、错误一律走 stderr。`--quiet` 只关掉进度日志，警告与错误照常打印。
- **`-h` / `--help`**：帮助打印到 stdout，退出 0，**不做任何事**（不渲染、不写文件、不联网、不起子进程）。`--version` 同理。
- **路径**：输出里的路径一律是仓库相对路径、正斜杠；不写本机绝对路径、主机名、用户名。

`--json` 信封（`schemaVersion` 1）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `schemaVersion` | 1 | 信封版本 |
| `ok` | 布尔 | `exitCode === 0` |
| `exitCode` | 整数 | 同第 1 节 |
| `command` | 字符串 | 命令名，如 `new-film`、`repo-check` |
| `error` | `{code, message, hint}` 或 `null` | 失败时的错误，字段见第 4 节 |
| `outputs` | `[{path, sha256, kind}]` | 这次写出的文件；演练与只读命令为空 |
| `runJson` | 路径或 `null` | 这次写的运行记录（run.json，附录 C8） |
| `warnings` | `[{code, message, hint}]` | 警告；与 stderr 上打印的相同 |
| `data` | 对象或 `null` | 命令自己的结果（各命令在自己的 `--help` 与本页第 10、11 节说明） |

```json
{ "schemaVersion": 1, "ok": false, "exitCode": 2, "command": "new-film",
  "error": { "code": "usage.unknown-option", "message": "不认识的选项 --titel", "hint": "是不是想写 --title？全部选项见 --help" },
  "outputs": [], "runJson": null, "warnings": [], "data": null }
```

## 3. 参数

- **位置参数**（如作品目录）可以写在选项前后任意位置；`--` 之后全部当位置参数。
- **长选项**用小写 kebab-case；`--name value` 与 `--name=value` 都行。开关不带值（`--dry-run`），也接受 `--dry-run=true|false`。只有 `-h` 有短写。
- **严格**：未知选项、选项缺值、非法数值、取值不在范围、多余或缺少的位置参数，一律退出 2，并给「是不是想写 --xxx」的建议。不接受选项缩写（`--jso` 不是 `--json`）。
- **统一词汇**（有这个意思的命令都用这些名字）：`--out <目录>`、`--size WxH`、`--fps N`、`--frame N`、`--frames a:b[:step]`（整数帧，含头不含尾）、`--workers N`、`--profile <档位>`、`--json`、`--dry-run`、`--force`、`--quiet`、`-h/--help`、`--version`。
- **环境变量只作默认值**：每个都有同名选项可以覆盖；新变量统一用 `BEIMING_` 前缀。已有的 `PYTHON`、`BEIMING_PY`、`RAEA_BIN`、`FFMPEG` 保留。
- **有副作用的命令**提供 `--dry-run`：只报告将要做什么，不写盘。

## 4. 错误

错误对象 `{code, message, hint}`：

- `code`：点分的机器码，**前缀决定退出码**：`usage.*` → 2、`env.*` → 3、`contract.*` → 4、`busy.*` → 5、`timeout*` → 124、`signal.sigint` / `signal.sigterm` → 130 / 143，其他（如 `failure.io`、`failure.internal`）→ 1。
- `message`：中文，一句话说清出了什么问题、在哪个文件或参数上。
- `hint`：下一步怎么做（一条命令、一个文件或一节文档）；确实没有时为 `null`。
- 未预期的异常记为 `failure.internal`（退出 1），默认不打印堆栈；设 `BEIMING_DEBUG=1` 重跑才打印。

## 5. 信号、超时与清理

- 命令登记的清理（临时目录、子进程、分段文件）在 SIGINT / SIGTERM 与抛错时都会执行，然后以 130 / 143 退出；`--json` 时照样输出信封。
- 有外部进程的命令给每个子进程设超时，超时按 124 退出并清理；不留残留进程和 `.segs-*`、`.new-*` 这类临时目录。
- 写文件先写临时位置再改名：中途失败或被中断，不留半个产物。

## 6. 跨平台

- 命令本身用 Node 或 Python 写，不依赖 bash 语法；文档里的命令写成仓库根目录执行的相对路径。
- 需要 POSIX `sh` 的老入口（如 A 模版的 `build.sh`）在 Windows 上要 Git Bash，统一入口 `npm run film` 建好后不再需要。
- 环境变量写法：POSIX `export NAME=值`；PowerShell `$env:NAME = '值'`。命令清单（第 9 节）与路线注册表里的命令都写成 argv 数组，不写成一整行 shell。
- stdout / stderr 用 UTF-8；Python 命令由 `cli.py` 统一改成 UTF-8（Windows 的 GBK 管道不会因中文出错）。

## 7. 命名

- npm 脚本按「域:动作」命名，如 `env:doctor`、`plan:check`、`cases:restore`；只向 agent 暴露 npm 脚本与 `node <路径>` 两种调用。
- 改名时旧名保留一个版本作为别名，调用时打印迁移提示（附录 C3）。
- 上游项目名（如 RAEA）不进新的脚本名、目录名、文件名（D04）；已有的 `raea:*` 作为别名保留。

## 8. 入口预算

新 agent 从 `AGENTS.md` → `routes/README.md` → 一份路线手册，不超过 3 份、300 行就要读到第一条可执行命令（北极星验收 1）。`npm run check:repo` 的 `core.entry-budget` 与 `core.reach` 两条规则执行这个预算：

| 文件 | 上限 |
|---|---|
| `AGENTS.md` | 150 行 |
| `routes/README.md` | 120 行 |
| `ROUTES.md` | 10 行（只做跳转页） |
| 每份路线手册 | 300 行 |
| `AGENTS.md` + `routes/README.md` + 手册里到第一条命令 | 300 行 |
| 从 `AGENTS.md` 沿链接到三份路线手册 | 不超过 3 跳 |

预算改动先在这里写明理由，再改 `tools/repo-check/rules/core/entry-budget.mjs`。

## 9. 命令清单

状态：**已接入**＝遵守本页全部约定，契约测试 `tests/cli/contract.test.mjs` 自动识别并逐个验证 `--help`、未知参数与 `--json`。识别规则：目标文件调用 `tools/lib/cli.mjs` 的 `runCli`（或 `cli.py` 的 `run`），或调用契约测试 `CLI_KITS` 里登记的各包自带外壳（`tools/env/lib/cli.mjs`、`tools/eval/lib/cli.mjs`、`tools/compliance/lib/cli.mjs`、`tools/qa/lib/cli-kit.mjs`、`tools/run-tests.mjs`；错误码与信封已与 `tools/lib/cli.mjs` 对齐，改用它之后从 `CLI_KITS` 删掉）。**待改造**＝命令已有，但 `--help` 或未知参数的行为还不合规，在契约测试的已知例外表里登记属主与原因，**不执行**。**例外（不适用）**＝设计上就不是本页意义上的命令（参数原样交给别的程序），同样登记在已知例外表里。**在建**＝附录 C3 已分配、尚未合入。`package.json` 里既没接入、也没登记为例外的脚本会让契约测试失败。

| npm 脚本 | 指向 | 属主 | 状态 |
|---|---|---|---|
| `new` | `tools/new-film.mjs` | 治理骨架 | 已接入 |
| `check:repo` | `tools/repo-check.mjs` | 治理骨架 | 已接入 |
| `plan:check`、`plan:next` | `tools/work-plan.mjs --check`、`--ready` | 治理骨架 | 已接入；旧名 `routes:check`、`routes:next` 已接入，保留一个版本，调用时提示改名 |
| `setup` | `tools/env/setup.mjs` | 环境 | 已接入 |
| `env:doctor`、`env:preflight`、`env:lock`、`env:large-files` | `tools/env/doctor.mjs`、`preflight.mjs`、`lock.mjs`、`large-files.mjs` | 环境 | 已接入 |
| `env:py` | `tools/env/py.mjs` | 环境 | 例外（不适用）：Python 启动器，除 `--help` 外的参数原样交给 Python |
| `remote` | `tools/remote/cli.mjs` | 环境 | 已接入 |
| `env:gpu` | `tools/rtx/gpucheck.mjs` | 渲染器 | 已接入 |
| `serve`、`site:serve` | `engine/render/serve.mjs`（`site:serve` 加 `--root out/site --port 8090`） | 渲染器 | 已接入；只监听 127.0.0.1 |
| `stills`、`video`、`video:4k` | `engine/render/still.mjs`、`video.mjs`（《北冥》样片） | 渲染器 | 已接入 |
| `film` | `tools/film/cli.mjs` | 出片编排 | 已接入：三条路线统一的 `npm run film -- build films/<名字>`（子命令 new / check / stills / animatic / build / render / review / status / qa / plan） |
| `beiming:build`、`build` | `tools/film/beiming.mjs` | 出片编排 | 已接入；《北冥》样片一键重建，`build` 是旧名，`sh build.sh` 是兼容壳 |
| `c:events`、`c:build` | `engine/render/events.mjs`、`build.mjs` | 出片编排 | 已接入（旧入口；新作品用 `npm run film -- build`） |
| `qa` | `tools/qa/cli.mjs` | 机器 QA | 已接入 |
| `golden`、`determinism` | `tools/baseline/golden.mjs`、`determinism.mjs` | 金标准 | 已接入 |
| `audio:build`、`audio:qa`、`audio:cuecheck`、`audio:voice`、`audio:samples` | `tools/audio/build.mjs`、`qa.mjs`、`cuecheck.mjs`、`voice.mjs`、`fetch-samples.mjs` | 声音 | 已接入 |
| `fonts:fetch`、`fonts:subset` | `tools/fonts/fetch.mjs`、`subset.mjs` | A 路线 | 已接入；A 作品出片前先 `fonts:subset films/<名字>` |
| `plates:check`、`plates:bleed`、`lookdev:sweep` | `tools/plates/check.mjs`、`bleed.mjs`、`tools/lookdev/sweep.mjs` | A 路线 | 已接入 |
| `b:preflight`、`b:render`、`b:prepare`、`b:runtime`、`b:rt` | `engine/render/native.mjs --check-only`、`native.mjs`、`engine/native/prepare.mjs`、`runtime.mjs`、`rt.mjs` | B 路线 | 已接入（`b:rt` 是光追外部后端，实验）；旧名 `native:*`、`raea:*`（例片 `examples/raea`）已接入，保留一个版本 |
| `native:prepare`、`native:check`、`native:render`、`native:bridge`、`native:sequence` | `engine/native/…`、`engine/render/native.mjs` | B 路线 | 已接入（旧名） |
| `raea:prepare`、`raea:check`、`raea:render` | `engine/native/prepare.mjs examples/raea`、`engine/render/native.mjs examples/raea [--check-only]` | B 路线 | 已接入（例片的旧名，保留一个版本） |
| `c:styles`、`c:styles:check` | `tools/c-styles.mjs` | C 路线 | 已接入 |
| `c:setup`、`c:runtime`、`c:fonts:check` | `tools/c-runtime.mjs setup`、`c-runtime.mjs`、`routes/c-style/fonts/fetch.mjs --check` | C 路线 | 已接入 |
| `test`、`check`、`lint` | `tools/run-tests.mjs`、`tools/check-all.mjs` | 测试与 CI | 已接入；旧名 `test:routes`、`test:engine`、`test:audio`、`test:cases` 是 `tools/run-tests.mjs --only <域>` 的别名 |
| `test:film`、`test:style`、`test:native` | `tools/run-tests.mjs --only film`、`style`、`native` | 各域属主 | 已接入 |
| `changelog:check`、`ci:smoke`、`ci:paths` | `tests/ci/changelog.mjs check`、`smoke-render.mjs`、`windows-paths.mjs` | 测试与 CI | 已接入 |
| `comp:scan`、`comp:rights`、`comp:signed-urls`、`comp:aigc` | `tools/compliance/scan.mjs`、`rights-inventory.mjs --check`、`signed-urls.mjs list`、`aigc.mjs` | 合规 | 已接入 |
| `eval:bank`、`eval:prepare`、`eval:drive`、`eval:reply`、`eval:finish`、`eval:status`、`eval:clean` | `tools/eval/run.mjs <子命令>` | 评测 | 已接入 |
| `eval:gates`、`eval:score`、`eval:summary`、`eval:selftest` | `tools/eval/gates.mjs`、`tools/eval/score.mjs run`、`summary`、`--self-test` | 评测 | 已接入 |
| `test:env`、`test:qa`、`test:comp`、`test:eval` | `node --test "tests/<域>/*.test.mjs"` | 各域属主 | 例外（不适用）：参数由 Node 的测试运行器解释；总入口 `npm test` 已接入 |
| `cases:list`、`cases:check`、`cases:restore`、`cases:index`、`cases:rights` | `tools/casebook.py` 经 `tools/env/py.mjs` | 案例库 | `casebook.py` 已接入 `cli.py`；经 `py.mjs` 启动的写法契约测试还认不出，登记为已知例外 |
| `site:build`、`site:qa` | `tools/build-showcase.py`、`tools/site-qa.mjs` | 作品站会话 | 待改造（作品站维护）：`site:build` 会重建 `out/site`，`site:qa` 的 `--json` 信封未接入 |

属主与原因以 `tests/cli/contract.test.mjs` 的 `KNOWN_EXCEPTIONS` 为准；表里没有、`package.json` 里新加的脚本会让契约测试失败。

## 10. 路线注册表（`routes/routes.json`）

三条路线的唯一注册表；读取与校验在 [tools/lib/routes.mjs](../tools/lib/routes.mjs)，`npm run check:repo` 的 `core.registry` 规则执行同一份校验。new-film、规范检查、工程计划与作品描述校验器都从这里读路线。

| 字段 | 说明 |
|---|---|
| `defaultProfile` | 新作品的默认交付档位（D07：`web-1080p24`） |
| `renderers` | 渲染器表：`page`（`engine/render`，无头 Chrome）、`native`（`engine/render/native.mjs` + 原生运行时） |
| `routes[].id` | 路线 id：`a`、`b`、`c`。film.json、工程计划与所有命令只认这三个值（工程计划另有 `shared`） |
| `routes[].slug` | 目录名：`routes/<slug>/` |
| `routes[].brand`、`label` | 对外品牌名（D04），不带 RTX、不用上游项目名 |
| `routes[].summary`、`chooseWhen` | 一句话定位与适用场景（与 `routes/README.md` 一致） |
| `routes[].aliases`、`legacyId` | 旧名与目录名（`beiming`、`raea`、`a-webgl`……）：命令接受并提示改写；`legacyId` 是工程计划 v1 与 ProjectSpec 用过的旧路线名（C 没有，写 `null`） |
| `routes[].backend`、`backends` | film.json 的 `backend` 默认值与允许值，与 `engine/production/film.js` 同口径：A `three`；B `native`；C `canvas`（也可 `svg`、`dom`、`three`、`webgl`） |
| `routes[].renderer` | 用到的渲染器 id |
| `routes[].upstream` | 上游项目：名字、仓库、许可、固定版本、是否随仓库分发、使用边界（D03、D04） |
| `routes[].manual`、`template` | 路线手册与模版目录 |
| `routes[].templateDefaults` | 模版 film.json 还是 v1 时，new-film 用它补齐 v2 的 `audio`、`style`（A 路线必填）、`aigc`、`credits` |
| `routes[].next` | 新建后的下一步：`[{stage, title, run: argv[], env?, requires?, output?}]`，`stage` 取 `look`、`animatic`、`build`、`check`、`final`；`run` 里可用 `{dir} {name} {dur} {fps} {width} {height} {size} {mid} {last} {midFrame} {lastFrame}`。模版 film.json 写了 `next` 就以模版为准 |

## 11. 新建作品（`npm run new`）

```sh
npm run new -- <a|b|c> <名字> [--title 片名] [--profile 档位] [--dry-run] [--check-timeout 秒] [--json]
```

- **名字**：小写字母、数字、连字符，字母或数字开头，最长 64；同时是目录名、film.json 的 `id` 与输出文件名。不得是 Windows 保留名，不得含上游项目名。片名用 `--title` 另给（不能含 `` " ' ` \ < > `` 与控制字符）。
- **占位符**：模版里只允许 `{{NAME}}` 与 `{{TITLE}}`。占位符＝两层花括号包住的大写标识符，中间没有空格，所以 JSX 的 `style={{ color: P.ink }}` 不受影响；替换后还残留 `{{大写标识符}}` 就退出 4、什么都不写。
- **复制**：模版的全部文件，包括点文件（B 模版的 `.gitignore`）；跳过 `out/`、`node_modules/`、`__pycache__/` 与模版自己 `.gitignore` 里列出的生成物目录。
- **film.json v2**（附录 C6，与 `engine/production/film.js` 的 v1 升级同口径）：`schemaVersion` 2、`id`＝名字、`route`＝注册表 id、`backend`、`output`（交付档位：`--profile` > 模版声明 > 注册表默认 `web-1080p24`）、`shots`（模版没写就整片一个镜头 `S1`）、`events`、`audio`、`deliveries`、`style`、`credits`、`aigc`（D11）、`gates`（look、animatic、final 三道，D08），以及路线自己的段（B 的 `native`、C 的 `cuecheck`）。v1 的 `poster`（秒）换成 `posterFrame`（帧）。模版里有 `dur`、`fps`、`size`（v1 写法）时保留为兼容镜像，数值按 `output` 重写，供现有出片脚本读取；改时长或画幅要两处一起改。排版与 `engine/production/io.js` 的 `formatJson` 相同。
- **换帧率**：`--profile` 的帧率与模版不同时，镜头、事件、停顿、海报帧按比例换算并提示；按节拍（`beat`）写的事件不自动换算，退出 4。
- **校验后落盘**：先写进 `films/.new-*` 暂存目录；有 `engine/production/film.js` 时在暂存目录上跑 `film.js check --json`，通过才整体改名为 `films/<名字>/`；不通过退出 4、校验器自身出错退出 1，两种情况都不留目录。`--dry-run` 不写任何文件，也不调用校验器。
- **下一步**：取模版 film.json 的 `next`，没有就取注册表这条路线的 `next`；`--json` 的 `data.next` 给出 argv、环境变量与产物路径，编排器不用解析 shell。
- 退出码：0 成功；1 写盘失败或校验器自身出错；2 路线、名字、片名、档位不合法或目录已存在；4 模版、注册表或生成的 film.json 不合格；124 校验器超时（`--check-timeout <秒>`，默认 60）；130 / 143 被中断，已杀掉校验器、删掉暂存目录。

## 12. 仓库规范检查（`npm run check:repo`）

```sh
npm run check:repo                              # 全部规则；--json、--only <域或规则>、--list、--strict、--staged、--root <目录>
```

- 规则按域放在 `tools/repo-check/rules/<域>/`：`core` 由治理骨架维护；`comp`（合规）、`agent`（agent 执行层）、`render`、`spec`、`film`、`qa`、`baseline`、`env`、`route-a`、`route-b`、`route-c`、`cases` 由各自的工作包维护。写规则见 [tools/repo-check/core/README.md](../tools/repo-check/core/README.md)。
- core 规则：路线注册表、路线 id、三份手册的 8 节、三个模版、全部非 vendor Markdown 的链接与锚点、入口口径（三条路线、上游项目名、产品名不带 RTX、选路线的判据只在 `routes/README.md`）、入口预算与可达性、根目录 CLAUDE.md 桥接、作品的 film.json 与占位符、`films/` 不提交媒体、`routes/` `films/` `tools/` `engine/` 的路径只用 ASCII、`engine/` 模块的中文注释、脚本与文档命令能照抄执行、`cases/vendor/` 快照只读。每条规则在 `tests/governance/fixtures/violations.json` 里至少有一个违规夹具，`node --test tests/governance` 断言报出对应规则 id 并退出 4。
- 退出码：0 没有错误（可以有提示）；4 有规范错误；2 用法错误；1 有规则自身出错（结果不完整）。
- **限期豁免**：属主还没轮到改的存量问题记在 `tools/repo-check/core/waivers.json`（规则、文件、匹配文字、属主、原因）；命中的错误降为提示并标出属主，`--strict` 时不降。问题修好后条目不再命中，检查会提示删掉它：豁免只减不增。

## 13. 引擎工程待办（`npm run plan:check`、`npm run plan:next`）

工程计划 `docs/routes/work-plan.json` 是引擎与工具的工程待办（D06）：T 编号是早先拆出的工程任务，H 编号是工业级加固的工作包。做作品不用它（作品由 film.json 与 `films/<名>/review/` 记录）。字段、领取与检查规则见 [docs/routes/work-breakdown.md](routes/work-breakdown.md)。

```sh
npm run plan:check                              # = node tools/work-plan.mjs --check；--strict、--json、--now <ISO 日期>、--file <计划>
npm run plan:next -- --route c                  # = node tools/work-plan.mjs --ready；路线 a / b / c / shared，旧名也认
node tools/work-plan.mjs --verify-diff <任务>   # 基线（默认取认领记录）以来的改动是否都在写入范围里
node tools/work-plan.mjs --cards                # 按 JSON 生成 work-breakdown.md 的依赖总览与任务卡
```

- 退出码：0 合格（可以有提示）；4 计划不合格（结构错误、两个在办任务写入范围重叠、认领过期、证据或指引文件不存在；`--strict` 时可领取任务的重叠与输入里写错的路径也算）或 `--verify-diff` 有越界改动；2 未知路线（列出注册表合法取值）、未知任务、参数冲突；3 `--verify-diff` 时没有 git。
- 旧名 `npm run routes:check`、`npm run routes:next` 保留一个版本：照常工作，并在 stderr 与 `--json` 的 `warnings` 里提示改名。
