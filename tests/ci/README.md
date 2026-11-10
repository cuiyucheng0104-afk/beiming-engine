# 测试、检查、CI 与发布

读者｜改了仓库、要确认「没改坏」的人和 agent；维护 CI 与发布的人

这里是仓库的质量入口：一条命令跑全部测试，一条命令跑全部检查，CI 在每个 PR 上跑同样的命令，打标签时自动出草稿 Release。命令都直接用 `node <路径>` 写，npm 脚本只是别名。

| 想做的事 | 命令 | 说明 |
|---|---|---|
| 跑全部测试 | `node tools/run-tests.mjs`（`npm test`） | 退出码 0 通过；1 有失败；3 环境缺依赖；124 超时 |
| 跑全部检查 | `node tools/check-all.mjs`（`npm run check`） | 规范、工程计划、测试、风格索引、案例库、导演规范、语法、更新日志 |
| 只看 lint 告警 | `node tools/check-all.mjs --only lint`（`npm run lint`） | 只报告，不影响退出码 |
| 无显卡冒烟出片 | `node tests/ci/smoke-render.mjs` | 三条路线的模版与《北冥》都真出一遍 |
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

## CI 的五个 job，以及在本机怎么复现

工作流在 `.github/workflows/ci.yml`。下面每条命令都与 job 里的一致，在仓库根目录运行。

### unit（Node 24 与 22、Python 3.12）

不装浏览器和 FFmpeg，需要它们的测试会自己跳过，留到 smoke-render 里跑。

```sh
npm ci
python3.12 -m venv .venv && .venv/bin/python -m pip install -r requirements.txt   # 有 requirements.lock 时用 --require-hashes -r requirements.lock
node tools/run-tests.mjs
```

PowerShell 的写法：`.venv\Scripts\python -m pip install -r requirements.txt`，测试命令相同。

### check

```sh
python3.12 -m venv /tmp/bm-lint && /tmp/bm-lint/bin/python -m pip install --require-hashes -r tests/ci/requirements-lint.txt
PATH="/tmp/bm-lint/bin:$PATH" node tools/check-all.mjs --skip tests
```

eslint 要等 `package.json` 的 devDependencies 登记了 eslint、@eslint/js、globals 之后，`npm ci` 才会装上；没装时这一步显示「跳过」，并写明原因。

### smoke-render（无显卡、软件渲染）

需要 playwright-core 锁定版本自带的 headless shell，以及 FFmpeg ≥ 7（带 libx264、aac、ebur128）。

```sh
./node_modules/.bin/playwright-core install chromium-headless-shell
export BEIMING_ANGLE=swiftshader BEIMING_GPU=software-ok      # macOS 上也能这样模拟 CI 的软件渲染
export BEIMING_PY="$PWD/.venv/bin/python"
node tools/run-tests.mjs --require browser,ffmpeg,python --skip-grep "R35 墨线：宽线"
node tests/ci/smoke-render.mjs --out out/ci/smoke
```

`smoke-render.mjs` 的几个阶段：

| 阶段 | 做什么 | 核对 |
|---|---|---|
| a | `new-film a` → 作品自带的 `build.sh --size 384x208` | 尺寸、帧数 = round(dur × fps)、帧率、H.264 yuv420p、BT.709 有限范围且四项标注齐全、AAC 48 kHz 立体声、−14 ± 1 LUFS、真峰值 ≤ −1.0 dBTP、中段一帧不是黑屏或纯色、关键帧 |
| c | `new-film c`，把尺寸改成 320x180 → `engine/render/build.mjs` | 同上，外加海报 |
| b | `new-film b` → `engine/native/prepare.mjs`（资产桥） | 声明的素材齐全、GLB 有效、prepared.json 的哈希与文件一致；再准备一遍，产物逐字节相同 |
| b-render | 只在设了 `RAEA_BIN` 时运行：`engine/render/native.mjs --quality draft` | 与 a、c 相同的成片核对 |
| beiming | 《北冥》1.5、4.0、7.6 秒与 lab 自测页 look 的静帧 | 不是黑屏或纯色 |
| golden | 有 `tools/baseline/golden.mjs` 时：清单在就比对，不在就首次采集 | 与金标准一致（退出码 4 表示像素变了） |

临时作品建在 `films/ci-smoke-*/`（页面服务只认仓库内的目录），结束、出错或被中断时都会删掉；加 `--keep` 可以保留下来排查。产物、报告和接触印 `contact.jpg` 放在 `--out` 指定的目录。`--plan` 只打印每段要跑的命令，不执行。

原生运行时不随仓库分发（D03），所以 CI 上的 b-render 总是跳过；在工作站上设好 `RAEA_BIN`，就能把三条路线都完整走一遍。

### env-smoke（Linux、macOS、Windows 三平台）

按锁文件一键装环境，再跑 A、C 两条路线的环境自检。B 路线要原生运行时，CI 上没有，所以不自检 B。这两个入口归环境工作包（`tools/env/`）：还没合入时，这两步自动跳过，job 照样是绿的。

```sh
node tools/env/setup.mjs
node tools/env/doctor.mjs --route a --json
node tools/env/doctor.mjs --route c --json
```

在三平台第一次跑通之前，这个 job 不阻塞合入。跑通后，把仓库变量 `BEIMING_ENV_SMOKE_REQUIRED` 设为 true，并在分支保护里把它加为必需检查。

### windows-paths（Windows Server 2025、PowerShell、无 Git Bash）

```powershell
npm ci
$env:BEIMING_PY = "$PWD\.venv\Scripts\python.exe"
node tools/run-tests.mjs
node tools/check-all.mjs --skip tests
node tests/ci/windows-paths.mjs
```

PowerShell 调 `npm.ps1` 时会吞掉单独的 `--`，参数传不到脚本里，所以要传参数时直接用 `node` 调入口。`windows-paths.mjs` 在 macOS 和 Linux 上也能跑，别名用符号链接代替目录联接。

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
| `engine/look/gpu.test.mjs` 的「R35 墨线：宽线…」在 SwiftShader 下要 60 秒以上（3840×2080 再 2 倍超采样），超过测试里 `page.goto` 的 30 秒默认时限 | smoke-render 的全部测试一步 | 引擎九层（engine/look） | ci.yml 里用 `--skip-grep "R35 墨线：宽线"` 隔离。测试按软件渲染缩小尺寸或放宽时限后，删掉这个参数。GPU 上照常运行 |
| 经符号链接或目录联接的绝对路径调用 `tools/new-film.mjs` 时退出码为 0，但什么都没建：入口判断拿 `process.argv[1]` 与真实路径直接比较 | windows-paths 的 new-film 项 | 治理骨架（tools/new-film.mjs） | 入口判断改为比较真实路径（可参考 `tools/run-tests.mjs` 的 `isMain`）。修好、job 转绿后，把仓库变量 `BEIMING_WINDOWS_REQUIRED` 设为 true |
| `PYTHONIOENCODING=gbk` 时 `tools/casebook.py list` 输出 `−`（U+2212）报 UnicodeEncodeError，退出码 1 | 中文 Windows 上把输出重定向到文件时 | 案例库工具、环境（tools/env/py.mjs） | Python 入口把标准输出改成 UTF-8，或统一经 `tools/env/py.mjs` 启动 |
| `tools/repo-check.mjs` 在 `routes/directing/craft/*.md` 报 25 处「内部代号」 | check job 的 repo 步骤为红 | 治理骨架（repo-check 规则） | 按 D04 放宽规则：上游名可以出现在技术说明与署名语境中 |
