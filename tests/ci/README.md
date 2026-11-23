# 测试、检查、CI 与发布

读者｜改了仓库、要确认「没改坏」的人和 agent；维护 CI 与发布的人

这里是仓库的质量入口：一条命令跑全部测试，一条命令跑全部检查，CI 在每个 PR 上跑同样的命令，打标签时自动出草稿 Release。命令都直接用 `node <路径>` 写，npm 脚本只是别名。

| 想做的事 | 命令 | 说明 |
|---|---|---|
| 跑全部测试 | `node tools/run-tests.mjs`（`npm test`） | 退出码 0 通过；1 有失败；3 环境缺依赖；124 超时 |
| 跑全部检查 | `node tools/check-all.mjs`（`npm run check`） | 规范、工程计划、测试、风格索引、案例库、导演规范、语法、更新日志 |
| 只看 lint 告警 | `node tools/check-all.mjs --only lint`（`npm run lint`） | 只报告，不影响退出码 |
| 无显卡冒烟出片 | `node tests/ci/smoke-render.mjs` | 四条路线的模版与《北冥》都真出一遍（无外部运行时或无 GPU 时 b-render / d-render 自动跳过） |
| 路径与编码检查 | `node tests/ci/windows-paths.mjs` | 目录联接、中文与空格路径、GBK 管道 |
| 校验更新日志 | `node tests/ci/changelog.mjs check` | Keep a Changelog 结构 |

所有命令都支持 `--help`（只打印用法，不做别的事）和 `--json`（stdout 只输出一个对象，见下文「输出约定」）。

## 改完代码要跑什么

1. `node tools/run-tests.mjs`：全部测试。只改了某一块时可以只跑那一域，例如 `--only engine`、`--only audio`。
2. `node tools/check-all.mjs --skip tests`：其余检查（测试已在第 1 步跑过）。
3. 动了渲染、模版或出片链路时，再跑一遍冒烟：`BEIMING_ANGLE=swiftshader node tests/ci/smoke-render.mjs`。

## 测试放在哪里，怎么被发现

`tools/run-tests.mjs` 按文件名发现仓库自己的测试：

- `*.test.mjs`、`*.test.js`、`*.test.cjs` 是 Node 测试（`node:test`）；`test_*.py` 是 Python unittest。
- 范围是 git 跟踪的文件，加上还没提交、也没被忽略的新文件。
- 不进 `cases/`（历史作品与第三方快照，自带的 test.js 跑不起来）、`films/`（用户作品）。任何一级叫 `fixtures`、`__fixtures__`、`node_modules`、`out`、`__pycache__` 或以点开头的目录也不进：故意写坏的夹具放进 `fixtures/`。

测试按「域」分组运行，`--only` 与 `--skip` 用的就是域名：

| 文件位置 | 域 |
|---|---|
| `tests/<域>/…` | `<域>`（新测试优先放这里，一个工作包一个域） |
| `engine/audio/…`、`audio/…` | `audio` |
| `engine/<其他层>/…` | `engine` |
| `lab/…`、`tools/…` 等其他目录 | 第一级目录名 |

同名的 `tests/<域>/` 与源码目录里的测试合成一个域，例如 `tests/engine/` 与 `engine/form/form.test.mjs` 都属于 `engine`。旧的 npm 脚本与域的对应：test:routes → `--only ci,production,tools`，test:engine → `--only engine,lab`，test:audio → `--only audio`，test:cases → `--only tools`。旧 `npm test` 里的 routes:check、cases:check 是检查不是测试，现在在 `tools/check-all.mjs` 里。

每个域的 Node 测试由一个 `node --test` 进程运行，Python 测试由一个解释器进程运行，域与域之间按顺序跑。

- **Python 模块名**：所在目录有 `__init__.py` 时，按相对仓库根的点分名导入，例如 `engine/audio/test_audio.py` 导入为 `engine.audio.test_audio`，包内的绝对导入照常可用。不是包时，把文件所在目录加进 `sys.path`，用文件名导入。
- **Python 解释器**：依次用 `--python`、`BEIMING_PY`、`BEIMING_PYTHON`、`PYTHON`、`tools/env/py.mjs`（环境包的统一入口）、仓库 `.venv`、`python3`、`python`、`py -3` 中第一个能跑的。明确指定的优先，`--python` 指向的解释器跑不起来时直接报错，不往下猜。
- **域的运行要求**：可以在 `tests/<域>/suite.json` 里声明，对整个域生效：

  ```json
  { "requires": ["browser", "ffmpeg", "python:numpy+scipy"], "timeoutSec": 600, "testTimeoutSec": 120, "concurrency": 1 }
  ```

  缺少某项能力时，整域跳过并写明原因。能力有 `python`、`python:<模块>`、`browser`（playwright-core 锁定版本的 headless shell）、`ffmpeg`、`sh`、`gpu`、`network`；其中 `gpu` 与 `network` 不自动探测，要设 `BEIMING_TEST_GPU=1` 或 `BEIMING_TEST_NETWORK=1` 才算具备。`--require <能力,…>` 把能力变成前置条件，缺了直接退出码 3，CI 的渲染 job 用它，保证该跑的测试没有因为缺浏览器而被悄悄跳过。
- **缺依赖不算代码坏了**：测试因为缺 `package.json` 或 `requirements*.txt` 里声明过的依赖而导入失败，整组标为「缺依赖」，退出码 3，并给出安装命令（`npm ci`；Python 侧运行 `npm run setup` 或 `pip install -r requirements.txt`，也可以用 `BEIMING_PY` 指向装好依赖的解释器）。没声明过的模块找不到，仍然按测试失败处理。
- **会开浏览器的测试**要自己判断浏览器在不在，不在就 `t.skip(原因)`；用完关掉浏览器、服务器和子进程。测试结束后进程组里还有残留进程，`run-tests` 会强制结束它们并写进 warnings。

## CI 的 job，以及在本机怎么复现

工作流在 `.github/workflows/ci.yml`：unit、check、render（tests-beiming、tests-rest、smoke 三路并行）、smoke-render（汇总 render 各路）、env-smoke、windows-paths。下面每条命令都与 job 里的一致，在仓库根目录运行。每个 job 都检出完整历史（`fetch-depth: 0`）：工程计划的证据提交、金标准清单的源提交都要在本仓库里找得到，浅克隆会报「找不到」。

### unit（Node 22、Python 3.12）

不装浏览器和 FFmpeg，需要它们的测试会自己跳过，留到 render (tests-*) 里跑。Node 24 的 Linux 全量测试由 render (tests-*) 两片合起来覆盖（同一台 Ubuntu、同一个 Node 24，只是多了浏览器与 FFmpeg），所以不再另跑 unit (Node 24)。

```sh
npm ci
python3.12 -m venv .venv && .venv/bin/python -m pip install -r requirements.txt   # 有 requirements.lock 时用 --require-hashes -r requirements.lock
node tools/run-tests.mjs --parallel   # CI 的写法：Python 组与 Node 组两条流水线同时跑；本机想按域顺序看输出就去掉 --parallel
```

PowerShell 的写法：`.venv\Scripts\python -m pip install -r requirements.txt`，测试命令相同。

### check

```sh
python3.12 -m venv /tmp/bm-lint && /tmp/bm-lint/bin/python -m pip install --require-hashes -r tests/ci/requirements-lint.txt
PATH="/tmp/bm-lint/bin:$PATH" node tools/check-all.mjs --skip tests
```

eslint 要等 `package.json` 的 devDependencies 登记了 eslint、@eslint/js、globals 之后，`npm ci` 才会装上；没装时这一步显示「跳过」，并写明原因。

### render 与 smoke-render（无显卡、软件渲染）

CI 里这一块是 matrix 三路并行，各自做一遍环境准备（装依赖、FFmpeg、字体、headless shell；Chromium 的 apt 依赖按 runner 镜像版本缓存下载包，不再每次走 Ubuntu 镜像）：`render (tests-beiming)` 跑 `--only beiming,audio` 那一片，`render (tests-rest)` 跑 `--skip beiming,audio`（同一组域，新增的域自动落进这一片，不会漏），`render (smoke)` 跑 `smoke-render.mjs`（含金标准）。`smoke-render` 是汇总任务，各路都通过才绿；检查名沿用拆分前，分支保护选它就不会漏掉任何一路。产物：`smoke` 一路上传 `smoke-render`（接触印、静帧、报告，`release.yml` 取它）与 `golden-capture-linux-swiftshader`，两片 tests 各上传 `render-tests-beiming`、`render-tests-rest`。各路互不依赖，本机想只验证其中一块就只跑对应那条命令。

需要 playwright-core 锁定版本自带的 headless shell，以及 FFmpeg ≥ 7（带 libx264、aac、ebur128）。

```sh
./node_modules/.bin/playwright-core install chromium-headless-shell
node tools/fonts/fetch.mjs                                      # A 模版的字体子集要锁定的 OFL 原始字体（一次即可）
export BEIMING_ANGLE=swiftshader BEIMING_GPU=software-ok      # macOS 上也能这样模拟 CI 的软件渲染
export BEIMING_PY="$PWD/.venv/bin/python"
node tools/run-tests.mjs --require browser,ffmpeg,python --skip-grep "R35 墨线：宽线"
node tests/ci/smoke-render.mjs --out out/ci/smoke
```

`smoke-render.mjs` 的几个阶段：

| 阶段 | 做什么 | 核对 |
|---|---|---|
| a | `new-film a` → `tools/fonts/subset.mjs`（按本片文字生成字体子集）→ `film build --size 384x216 --gpu software-ok` | 尺寸、帧数 = film.json 的 output.frameCount、帧率、H.264 yuv420p、BT.709 有限范围且四项标注齐全、AAC 48 kHz 立体声、−14 ± 1 LUFS、真峰值 ≤ −1.0 dBTP、中段一帧不是黑屏或纯色、联系表 |
| c | `new-film c` → `film build --size 320x180 --gpu software-ok` | 同上，外加海报 |
| b | `new-film b` → `engine/native/prepare.mjs`（资产桥） | 声明的素材齐全、GLB 有效、prepared.json 的哈希与文件一致；再准备一遍，产物逐字节相同 |
| b-render | 只在设了 `RAEA_BIN` 时运行：`film build --gpu software-ok`（B 的画幅只来自 film.json，按模版原尺寸出） | 与 a、c 相同的成片核对 |
| d-render | 只在本机有光追运行时缓存（或设了 `BEIMING_PT_BIN`）且 GPU 探测可用时运行：`new-film d` → `film build --size 384x216` | 与 a、c 相同的成片核对与中段静帧接触印 |
| beiming | 《北冥》1.5、4.0、7.6 秒与 lab 自测页 look 的静帧 | 不是黑屏或纯色 |
| golden | 有 `tools/baseline/golden.mjs` 时：清单在就比对，不在就首次采集 | 与金标准一致（退出码 4 表示像素变了） |

临时作品建在 `films/ci-smoke-*/`（页面服务只认仓库内的目录），结束、出错或被中断时都会删掉；加 `--keep` 可以保留下来排查。产物、报告和接触印 `contact.jpg` 放在 `--out` 指定的目录。`--plan` 只打印每段要跑的命令，不执行。

外部运行时不随仓库分发（D03、D13），所以无显卡 CI 上的 b-render 与 d-render 总是跳过；在工作站上设好 `RAEA_BIN` 与光追运行时缓存（或 `BEIMING_PT_BIN`），就能把四条路线都完整走一遍。

### env-smoke（Linux、macOS、Windows 三平台）

按锁文件一键装环境，装 FFmpeg（Linux、Windows 用与 smoke-render 同一版 BtbN 静态构建并核对 sha256，macOS 用 Homebrew；`setup.mjs` 不装系统工具），再跑 A、C 两条路线的环境自检。B 路线要原生运行时，CI 上没有，所以不自检 B。这两个入口归环境工作包（`tools/env/`）：还没合入时，这两步自动跳过，job 照样是绿的。

```sh
node tools/env/setup.mjs
node tools/env/doctor.mjs --route a --json
node tools/env/doctor.mjs --route c --json
```

env-smoke 与 windows-paths 都没有 `continue-on-error`：红了就是红，偶发红灯找根因修、不加重试。建议在分支保护里把它们加为必需检查。

### windows-paths（Windows Server 2025、PowerShell、无 Git Bash）

```powershell
npm ci
$env:BEIMING_PY = "$PWD\.venv\Scripts\python.exe"
node tools/run-tests.mjs
node tools/check-all.mjs --skip tests
node tests/ci/windows-paths.mjs
```

PowerShell 调 `npm.ps1` 时会吞掉单独的 `--`，参数传不到脚本里，所以要传参数时直接用 `node` 调入口。`windows-paths.mjs` 在 macOS 和 Linux 上也能跑，别名用符号链接代替目录联接。

### conformance-5090（帧源一致性，RTX 5090 自托管运行器，限 10 分钟）

工作流在 `.github/workflows/conformance-5090.yml`，与 ci.yml 分开，不进 ci.yml 的必需检查。

- **PR**：先跑轻量 `filter`（托管 runner，限 5 分钟），`tests/ci/conformance-filter.mjs` 判定变更路径是否触及帧源与一致性边界：`beiming/sources/`、`beiming/host/`、`beiming/kernel/conformance/`、`beiming/kernel/contracts/source/`、`beiming/kernel/contracts/meta/`、`beiming/calib/`（按整段目录匹配，`beiming/sources-notes/` 不算；路径原样比较，前导空格的顶层目录 ` beiming/sources/` 不算；`--null` 时 `\` 是文件名里的普通字符，根目录的 `beiming\sources\notes.txt` 不算，不带 `--null` 手工传 Windows 路径时才把 `\` 当分隔符）。差异用 `git diff -z --name-only --no-renames "$BASE_SHA...$HEAD_SHA"`：`-z` 配 `--null`，中文与制表符路径不会被 git 转义成引号串；三点差异看整个 PR，不只最后一个提交。只改 `beiming/api` 等其他目录、`docs/`、`site/` 的 PR 输出 `frame_sources_changed=false`，不排显卡队。
- **信任边界**：显卡任务与夜间重建跑在自托管机器上，只接同仓分支的 PR（`github.event.pull_request.head.repo.full_name == github.repository`）；fork 来的 PR 只跑 `filter`，显卡任务跳过，要跑由维护者把分支推到本仓库。
- **夜间**（schedule，北京时间 02:00；也可 workflow_dispatch / workflow_call）：`exam`（考试）→ `conformance-5090` → `nightly-rebuild`（夜间重建），一致性排在考试之后、夜间重建之前。`nightly-rebuild` 的条件显式写 `!cancelled() && needs['conformance-5090'].result == 'success'`：不写状态函数会被套上隐式 `success()`，夜间链里祖先 `filter` 是 skipped，会把夜间重建连带跳过。考试与夜间重建的入口（`beiming/bench/exam.mjs`、`tools/nightly/rebuild.mjs`）还没合入，缺入口时这一步只打一条 `::notice::` 占位提示、job 照常绿，链上的下一步照跑。`workflow_call` 有输入 `mode`（默认 `nightly`）：调用方即使是 PR 也走夜间链；传 `mode: pr` 才走 `filter` 分支。从 PR 调用 `workflow_call` 时 `github.event_name` 也是 `pull_request`，所以另有内部布尔输入 `from_call`（默认 `true`，调用方不要传；直接由 `pull_request` 触发时没有 inputs，为假）区分两者，传 `mode: ''` 也走夜间链。
- **显卡任务跑什么**：先确认无头浏览器可用，再真起停一次 three 帧源（只有空的浏览器版本目录时第一步也会过，而 `render.test.mjs` 起不了帧源就 `t.skip`、整步照绿；两步任一不过都 exit 3），再跑一致性套件、校准检查和帧源实渲测试（`beiming/sources/three`、`beiming/sources/blender`、`beiming/host/page`）；three 实渲测试用 TAP 报告单独跑并落盘，再由 Node 读回核对：读不到文件、没有用例、汇总里跳过数非零或出现 `# SKIP` 都不过（exit 3；预检之后测试自己再起帧源仍可能起不来而 `t.skip`，`node --test` 照样退出 0；不用 `tee` / `grep`，缺命令或文件读不了时 `if grep` 会当成没有跳过放行；Blender 测试在没有 Blender 的机器上可以跳过，不查）；只读表的测试把 Three 的 `render()` 改坏也全绿，实渲测试会红。
- **显卡队**：运行器标签 `[self-hosted, linux, x64, rtx5090]`，`concurrency: gpu-5090` 串行、不取消进行中的任务。仓库变量 `BEIMING_5090_RUNNER` 设为 `true`（运行器注册好之后由维护者设置）之前，显卡任务一律跳过，不会卡在排队里。同组最多一个在跑、一个在排（pending），再来的会顶掉排着的那个，所以只有 `conformance-5090` 进这个组。

```sh
git diff -z --name-only --no-renames origin/main...HEAD | node tests/ci/conformance-filter.mjs --null   # 本 PR 会不会排显卡队
node --input-type=module -e "const { startSource } = await import('./beiming/host/page/host.mjs'); const s = await startSource(); await s.stop();"   # 预检先确认帧源起得来；跑套件时再由 Node 核对 Three 的 TAP 报告 0 跳过
node --test 'beiming/kernel/conformance/*.test.mjs' 'beiming/calib/*.test.mjs' \
  'beiming/sources/blender/*.test.mjs' 'beiming/host/page/*.test.mjs'   # 显卡任务跑的套件（three 实渲测试单独跑，见下面几行）
# three 实渲测试：TAP 落盘后由 Node 读回核对，读不到、没有用例、有跳过都 exit 3；测试自己失败按它的退出码（与工作流同一段；包在子 shell 里，exit 不会关掉终端）
( TAP=/tmp/conformance-5090-three.tap; rc=0
  node --test --test-reporter=tap 'beiming/sources/three/*.test.mjs' > "$TAP" || rc=$?
  TAP="$TAP" node --input-type=module -e "import fs from 'node:fs'; const tap = fs.readFileSync(process.env.TAP, 'utf8'); process.stdout.write(tap); if (!/^# tests [1-9]/m.test(tap) || /^# skipped [1-9]/m.test(tap) || /# SKIP\b/.test(tap)) { console.error('::error::5090 上 three 实渲测试有被跳过或未产出有效 TAP，不能当绿灯'); process.exit(3); }" || exit $?
  test "$rc" -eq 0 || exit "$rc" )
```

## 金标准首次采集

smoke-render 在 SwiftShader 下的平台键是 `linux-swiftshader`（本机用 SwiftShader 模拟时是 `<系统>-swiftshader`）。比对工具与清单格式归 `tools/baseline/`、`docs/style-baselines/POLICY.md`（基线工作包）。还没有 `tests/golden/linux-swiftshader/manifest.json` 时，CI 会运行采集，把结果上传为工件 `golden-capture-linux-swiftshader`，这一次不做比对，在 summary 里给出提示。提交清单的步骤：

1. 在 Actions 里打开这次运行，确认 smoke-render 的接触印画面正常：采集到的就是以后的基准，画面不对时不要提交。
2. 在仓库根目录取回工件：`gh run download <运行编号> -n golden-capture-linux-swiftshader -D .`。工件里保留了仓库相对路径，文件会落在 `tests/golden/linux-swiftshader/`。
3. 只提交清单：`git add tests/golden/linux-swiftshader/manifest.json`。帧图按 POLICY.md 放 Release 或 LFS，不进 git。
4. 之后的 CI 都会比对。像素有变化时退出码为 4：如果是有意改动，按 POLICY.md 走基线更新，在同一个 PR 里更新清单，并在 CHANGELOG 里写明改了哪些画面。

## 发布

1. 把 CHANGELOG.md 中 `[Unreleased]` 的条目移到新的 `## [X.Y.Z] - YYYY-MM-DD` 下，文末补上比较链接。同时把 `package.json` 的 version 改成 `X.Y.Z`（注册文件由集成负责人改）。合入 main。
2. 在 main 的这个提交上打标签并推送：`git tag vX.Y.Z && git push origin vX.Y.Z`。
3. `release.yml` 依次运行：
   - 核对标签是不是语义化版本、在不在 main 上、是否与 package.json 一致、CHANGELOG 有没有对应段落；
   - 跑整套 CI，静帧按 1920x1040 出；
   - 建草稿 Release：正文取自 CHANGELOG 的对应段落，有 `docs/rights/RELEASE-FOOTER.md` 时把它附在末尾作署名区块；附件是接触印与静帧压缩包。
4. 维护者在 Releases 页核对说明与附件后，点「发布」。发布是公开、不可撤回的动作，流水线不会自动完成。

`node tests/ci/changelog.mjs notes vX.Y.Z --package package.json` 可以在本机预览说明，并检查版本号是否对得上；`notes --unreleased` 预览还没发布的部分。

v1.0 标签停在首个提交，GitHub 上的 Latest 仍指向它。要替换，在当前 main 打新版本标签，并发布对应的 Release。这一步是公开动作，需要维护者确认后执行。

## lint（只报告）

- eslint：配置是仓库根的 `eslint.config.js`（扁平配置），需要开发依赖 eslint 10.13.0、@eslint/js 10.0.1、globals 17.13.0。按目录区分浏览器端与 Node 端，会把回调交给 `page.evaluate` 的 Node 脚本同时给两种全局变量。
- ruff：配置是 `ruff.toml`，只开 E9 与 F 两组真错误。版本按哈希固定在 `tests/ci/requirements-lint.txt`。
- 2026-11-10 实测（eslint 10.13.0、ruff 0.17.2）：eslint 共 153 个文件，8 个错误、23 个警告。按规则分：no-unused-vars 23、no-useless-assignment 5、no-control-regex 2、preserve-caught-error 1；按目录分：src/ 22、engine/ 3、site/ 3、tools/ 2、routes/ 1。ruff 1 条告警：`routes/a-webgl/template/sound.py:18` 的 F401。这些都在别的工作包的存量代码里；本目录与 `tools/run-tests.mjs`、`tools/check-all.mjs`、`eslint.config.js` 为 0。存量告警由各自的属主逐步清理，不为了过 lint 去改别人的文件。

## 输出约定

退出码按统一约定：

| 码 | 含义 |
|---|---|
| 0 | 通过 |
| 1 | 失败 |
| 2 | 用法错误 |
| 3 | 环境或依赖缺失 |
| 4 | 契约或验收不通过：没发现测试、金标准不一致、更新日志不合规 |
| 124 | 超时，已结束整棵进程树 |
| 130 / 143 | 收到 SIGINT / SIGTERM，已清理 |

`--json` 时，stdout 只有一个对象 `{ok, exitCode, command, error: {code, message, hint} | null, outputs, runJson, warnings, …}`，各命令另带自己的字段：run-tests 带 `summary`、`suites`，check-all 带 `steps`，smoke-render 带 `phases`。供人看的进度一律写到 stderr。`--report <文件>` 把同一个对象另存一份，CI 会把它上传为工件。

在 GitHub Actions 里（`GITHUB_ACTIONS=true`），失败的测试与检查会写成注解，汇总表写进 job summary。

## 已知问题与隔离项

| 现象 | 影响 | 负责的工作包 | 处理与解除条件 |
|---|---|---|---|
| `engine/look/gpu.test.mjs` 的「R35 墨线：宽线…」在 SwiftShader 下要 60 秒以上（3840×2080 再 2 倍超采样），超过测试里 `page.goto` 的 30 秒默认时限 | render (tests) 一路的全部测试一步 | 引擎九层（engine/look） | ci.yml 里用 `--skip-grep "R35 墨线：宽线"` 隔离。测试按软件渲染缩小尺寸或放宽时限后，删掉这个参数。GPU 上照常运行 |
