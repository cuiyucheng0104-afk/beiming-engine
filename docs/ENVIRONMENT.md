# 运行环境：安装、版本与常见问题

> 读者｜第一次在 macOS、Windows（PowerShell）或 Linux 上跑本仓库的人与 agent　状态｜生效　依据｜[决定 D09、D10](decisions/2026-11-10-industrial-baseline.md)；要求的唯一来源是 [`tools/env/spec.json`](../tools/env/spec.json)，本页的版本表与环境变量表由 `repo-check` 的 env 规则对照它校验

## 三条命令

在仓库根目录执行，bash、zsh 与 PowerShell 写法相同：

```
npm ci
npm run setup
npm run env:doctor -- --route a
```

- `npm run setup` 建好全部依赖：npm 包、锁定版本的无头浏览器、仓库内的 Python 3.12 虚拟环境 `.venv`。它是幂等的，第二次运行不下载任何东西。
- `npm run env:doctor` 只读体检。每一项给出「修复」命令，必需项不合格时退出码 3；照着修完再跑，直到退出码 0。`--route a|b|c` 只看某条路线需要的项。
- 脚本注册之前，直接运行同一个文件：`node tools/env/setup.mjs`、`node tools/env/doctor.mjs`。

新环境第一次跑 setup 大约要 2–5 分钟（下载浏览器约 100 MB、Python 依赖约 70 MB）。之后每次 doctor 约 2 秒。

## 版本要求

| 组件 | 要求 | 怎么锁定 | doctor 检查项 |
|---|---|---|---|
| Node.js | `>= 22.0.0`，推荐 24 | `.nvmrc`（24）；`package.json` 的 `engines` | `node.version` |
| npm 依赖 | three 0.170.0、gsap 3.15.1、playwright-core 1.63.0 | `package-lock.json`，`npm ci` 安装 | `npm.lock`、`playwright.core` |
| 无头浏览器 | chromium-headless-shell r1243（153.0.8010.12） | playwright-core 1.63.0 自带的版本表；setup 用仓库里的 playwright-core 安装 | `browser.headless-shell`、`browser.launch`、`gpu.renderer` |
| FFmpeg 与 ffprobe | 7 以上；必须有 libx264、aac 编码器，loudnorm、ebur128、apad、aresample、scale、format、fps、noise 滤镜，mp4 封装，concat 与 image2pipe 读入 | 系统安装（各平台命令见下文） | `ffmpeg.version`、`ffmpeg.components`、`ffprobe.version` |
| Python | 3.12 | `.python-version`；`requirements.in` → `requirements.lock`（macOS arm64、Windows x64、Linux x64，带哈希，只用二进制轮子） | `python.interpreter`、`python.packages` |
| 原生运行时（B 路线） | 0.1.0-canary.2 | `RAEA_BIN` 指向的安装包里的 `share/raea/VERSION` | `raea.runtime`（`--route b`） |

锁文件里的 Python 包：numpy 2.5.4、scipy 1.18.1、numba 0.68.1（llvmlite 0.50.0）、soundfile 0.14.0、soxr 1.1.0、pillow 13.0.0，以及它们的依赖。完整清单与哈希见 [`requirements.lock`](../requirements.lock)。

QA 还会用到 blackdetect、freezedetect、signalstats、select、gblur、ssim、psnr 滤镜和 framemd5 封装；缺了只告警。Playwright 安装浏览器时会顺带下载一个精简版 ffmpeg，它没有 libx264，不能用来出片，doctor 会指出来。

## 平台

| 平台 | 状态 | GPU 后端（`BEIMING_ANGLE`） | 说明 |
|---|---|---|---|
| macOS arm64 | 全新克隆上实测过 setup 与 doctor | `metal`（默认） | 主力开发机 |
| Windows x64（NVIDIA RTX 工作站） | 锁文件已按此平台解析；setup 与 doctor 尚待在工作站上实测 | `vulkan` | 主力出片机，见 [RTX 工作站](RTX工作站.md)；出片封装暂时还要 Git Bash 里的 `sh` |
| Linux x64 | 锁文件已按此平台解析；CI 目标平台 | 有 NVIDIA 用 `vulkan`；没有显卡时用 `swiftshader`，按软件渲染记录 | 需要系统库与中文字体 |

## 安装：macOS

```bash
brew install node@24 ffmpeg uv     # 已有 Node 22 以上可以不装 node@24
npm ci
npm run setup
npm run env:doctor -- --route a
```

- 不需要系统里有 Python 3.12：uv 会自动下载一份放进 `.venv`。不装 uv 时，setup 改用 `python3.12 -m venv`（`brew install python@3.12`）。
- Homebrew 的 Python 禁止直接 `pip install`（报 externally-managed-environment），所以不要照旧文档执行 `pip install -r requirements.txt`，一律用 setup。

## 安装：Windows（PowerShell）

```powershell
winget install --id OpenJS.NodeJS.LTS -e
winget install --id Gyan.FFmpeg -e
winget install --id astral-sh.uv -e
winget install --id Git.Git -e
# 重开 PowerShell 让 PATH 生效，然后在仓库根目录：
git config core.autocrlf false
git config core.quotepath off
npm ci
npm run setup
npm run env:doctor -- --route a
```

```bash
# Git Bash 里命令相同（winget 需在 PowerShell 或 cmd 里执行）：
git config core.autocrlf false && git config core.quotepath off
npm ci && npm run setup && npm run env:doctor -- --route a
```

- **克隆到短的英文路径**，例如 `D:\beiming\repo`。中文路径下部分老工具会出编码问题，过长的路径会撞上 Windows 的路径长度限制。
- **换行**：仓库的 `.gitattributes` 已经让文本一律按 LF 检出，`core.autocrlf` 设成什么都不影响；上面那条 `git config core.autocrlf false` 是给旧检出的保险。
- **Python**：Windows 上通常没有 `python3` 命令，`python` 可能只是应用商店的空壳。仓库的 npm 脚本与文档统一经 `node tools/env/py.mjs` 启动 Python，它会找到 `.venv`；自己调用时也这样写：`node tools/env/py.mjs tools/casebook.py list`。
- **中文输出**：`py.mjs` 固定 `PYTHONUTF8=1`、`PYTHONIOENCODING=utf-8`，重定向到文件或管道时不会再报 `UnicodeEncodeError: 'gbk'`。直接调用 Python 时先设 `$env:PYTHONUTF8 = '1'`。
- **sh（过渡期）**：A 的 `build.sh`、C 的 `engine/render/build.mjs`、B 的 `native.mjs` 目前都要用 sh 调用 `engine/render/mux.sh`（清单见下文「sh 入口盘点」）。装 Git for Windows 后，doctor 会自己找到 `Git\bin\sh.exe`；但这些入口按名字调用 `sh`，所以还要把 **`Git\bin`** 加进 PATH：`$env:Path += ';C:\Program Files\Git\bin'`（当前窗口有效；长期生效在「系统属性 → 环境变量」里加）。不要加 `Git\usr\bin`：那里的 `find`、`sort` 会盖掉 Windows 自带的同名命令，而且直接用 `usr\bin\sh.exe` 时脚本里找不到 sed、awk。装在别处时设 `$env:BEIMING_SH`。Node 版封装合入后不再需要 sh。
- **PowerShell 拦截 npm**：报「此系统上禁止运行脚本」时，把命令里的 `npm` 换成 `npm.cmd`，或者由你自己决定是否执行 `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`。
- 设环境变量用 `$env:名字 = '值'`（只对当前窗口有效），不要照抄 bash 的 `名字=值 命令` 写法。

## 安装：Linux

```bash
# Node 24：nvm install 24（或发行版 / NodeSource 包）；uv：
curl -LsSf https://astral.sh/uv/install.sh | sh
# FFmpeg 7 以上：Ubuntu 25.04+ 可以 sudo apt-get install ffmpeg；更早的发行版用静态版（例如 johnvansickle.com 的 release 版），解压后加进 PATH
sudo apt-get install fonts-noto-cjk
npm ci
npm run setup -- --with-deps        # --with-deps：同时装无头浏览器需要的系统库（要 sudo）
npm run env:doctor -- --route a
```

- 没有显卡的机器（包括 CI）上 WebGL 走 SwiftShader 软件渲染：能出片但每帧 2–4 秒，画面与硬件渲染有细微差别。doctor 默认只告警；交付渲染加 `--gpu required` 让它直接失败。
- 有 NVIDIA 显卡时设 `BEIMING_ANGLE=vulkan`，并确认装了 Vulkan 运行库（`libvulkan1`）与驱动。
- 没有中文字体时，页面字体子集缺的字会回退成方块；doctor 的 `fonts.system-cjk` 一项会提示。

## setup 做了什么

| 步骤 | 做什么 | 什么时候跳过 |
|---|---|---|
| npm | `npm ci` | `node_modules` 与 `package-lock.json` 一致；`node_modules` 是指向别处的链接时拒绝改动并退出 3 |
| 浏览器 | `node node_modules/playwright-core/cli.js install chromium-headless-shell`，Linux 加 `--with-deps` 时带系统库 | r1243 已装全（有 `INSTALLATION_COMPLETE` 标记） |
| Python | 有 uv：`uv venv --python 3.12 .venv`，再 `uv pip sync --require-hashes --only-binary :all: --compile-bytecode requirements.lock`；没有 uv：`python3.12 -m venv .venv`，再 `pip install --require-hashes --only-binary :all: -r requirements.lock`；装完导入一次核心模块 | `.venv` 是 setup 建的、Python 3.12、记录的锁文件哈希与现在一致，且核对通过 |
| 钩子 | `git config core.hooksPath .githooks` | 仓库里没有 `.githooks/`，或已经设好 |

- `--dry-run` 只列出每一步会做什么，不下载、不写文件。`--json` 输出 C2 信封（`steps` 字段是每一步的结果）。
- `.venv` 不是 setup 建的、又不能用（例如 Python 版本不对）时，setup 不会擅自删除，会退出 3 并提示 `--recreate-venv`。
- 被 Ctrl+C 打断时会结束所有子进程；重跑会从没完成的步骤继续。
- 退出码：0 成功；2 用法错误；3 缺前置条件（Node 太旧、没有 uv 也没有 Python 3.12）；1 某一步失败；124 超时；130 / 143 被中断。

## doctor 怎么读

每一项一行：`OK`、`FAIL`、`WARN`、`INFO`、`SKIP`，后面是检查项编号、实际找到的东西；不合格的项另有「修复」一行，可以直接复制执行。`--json` 时 stdout 只有一个对象，`checks` 是全部检查项，每项含 `id`、`ok`、`required`、`found`、`expected`、`fix`。

| 选项 | 作用 |
|---|---|
| `--route a\|b\|c` | 只看某条路线需要的项；可以重复或用逗号分隔。不写时检查通用项，B 路线的原生运行时只作提示 |
| `--gpu required` | 要求硬件 GPU：软件渲染，或者有 NVIDIA 显卡却落到核显，都判失败 |
| `--quick` | 不启动浏览器、不导入 Python 模块、不跑案例库校验，约 1 秒 |
| `--out <文件>` | 另把报告写到文件 |

出片入口在渲染第一帧之前调用 [`tools/env/preflight.mjs`](../tools/env/preflight.mjs)：只查文件、版本与可执行程序，1 秒内给出缺什么、怎么补。命令行用法：`node tools/env/preflight.mjs --need browser,ffmpeg,python:audio`。

## Python 从哪里来

所有工具按同一顺序找解释器，第一个能运行的就用（实现：[`tools/env/lib/python.mjs`](../tools/env/lib/python.mjs)）：

`BEIMING_PYTHON` → `BEIMING_PY` → `PYTHON` → 仓库的 `.venv` → `python3` → `python` → `py -3.12` → `py -3`

- 显式设置的变量或 `.venv` 坏了会直接报错（退出码 3），不会悄悄换成别的解释器。
- `PYTHON` 也是 node-gyp 读的变量。如果全局设过它，它会盖过仓库的 `.venv`，doctor 会提示取消。
- 看当前选中了哪个：`node tools/env/py.mjs --which`。

## 环境变量

doctor 的 `env.vars` 一项会列出当前生效的变量，并提示 `BEIMING_`、`BNE_`、`RAEA_` 开头却不在下表里的变量（多半是拼错）。下表与 [`tools/env/spec.json`](../tools/env/spec.json) 一一对应；代码里新读一个变量而没有登记，`repo-check` 会报错。

| 变量 | 归属 | 作用 | 默认 |
|---|---|---|---|
| `BEIMING_ANGLE` | 渲染（engine/render） | 无头浏览器的 ANGLE 后端：metal / vulkan / gl / d3d11 / swiftshader / default | macOS 为 metal，其它平台不传参数；Windows 双显卡机上会落到核显，NVIDIA 机器设 vulkan |
| `BEIMING_CHROME` | 渲染（engine/render） | 改用指定的浏览器可执行文件 | 锁定的 headless shell 153；不设最好，换浏览器会破坏跨机器一致性 |
| `BEIMING_READY_TIMEOUT` | 渲染（engine/render） | 等页面声明 `window.READY` 的上限（秒） | 180 |
| `BEIMING_FRAME_TIMEOUT` | 渲染（engine/render） | 单帧 `render(t)` 的上限（秒），超时按失败处理 | 300 |
| `WORKERS` | 渲染（engine/render） | `build.sh` 1080p 出片时并行的浏览器数 | 4 |
| `WORKERS_4K` | 渲染（engine/render） | `build.sh --4k` 时并行的浏览器数 | 8 |
| `FFMPEG` | 编码 | ffmpeg 可执行文件（完整路径）。目前只有 B 路线入口与 `tools/env` 识别；`engine/render/video.mjs`、`mux.sh`、`build.sh`、`audio/check.py` 仍从 PATH 调用 | PATH 里的 ffmpeg |
| `FFPROBE` | 编码 | ffprobe 可执行文件，识别范围同上 | PATH 里的 ffprobe |
| `BEIMING_PYTHON` | Python | 指定解释器（正式名，优先级最高） | 按上一节的顺序查找 |
| `BEIMING_PY` | Python | `BEIMING_PYTHON` 的别名（C 路线 `build.mjs` 沿用） | 同上 |
| `PYTHON` | Python | 旧写法：sh 入口与 B 路线 prepare 用它指定解释器 | `python3`（Windows 上 prepare 用 `python`） |
| `PYTHONPATH` | Python | py.mjs 与 B 路线 prepare 把仓库根加到最前面，脚本里可以直接 `import engine.audio` | 由工具设置 |
| `PYTHONUTF8` | Python | py.mjs 固定设为 1 | 由工具设置 |
| `PYTHONIOENCODING` | Python | py.mjs 固定设为 utf-8，覆盖外部的 gbk 等设置 | 由工具设置 |
| `NUMBA_CACHE_DIR` | Python（numba） | numba 编译缓存目录；仓库目录只读时改到可写处 | `engine/audio/__pycache__` |
| `BEIMING_SAMPLES` | 声音 | CC0 采样库目录；只有重渲配乐（`sh audio/build.sh --score`）需要 | 不设，用 `audio/score_cache.npz` |
| `BEIMING_CJK_FONT` | 声音 | 声音自检图（`engine/audio/scope.py`）用的中文字体文件；找不到系统中文字体时设它 | 按 macOS、Windows（`%WINDIR%\Fonts`）、Linux 的常见位置查找 |
| `BEIMING_SH` | 过渡期 sh | POSIX sh 的完整路径；Windows 上 Git for Windows 装在非默认位置时用。sh 入口全部改成 Node 后不再需要 | PATH 里的 sh；Windows 上再找 Git for Windows 的 `bin\sh.exe` |
| `RAEA_BIN` | B 路线 | 原生运行时可执行文件的完整路径；安装包要保留 `bin/` 与 `share/` | 不设（B 路线必需） |
| `BNE_ALLOW_VERSION` | B 路线 | 临时放行未验证的运行时版本（先重跑验收） | 不设 |
| `WGPU_BACKEND` | B 路线（wgpu） | 原生运行时的图形后端；与 `BEIMING_ANGLE` 是两套设置 | Windows 上 native.mjs 设为 vulkan |
| `COMFY_URL` | B 路线 | 共享 GPU 检查时查询的 ComfyUI 队列地址 | `http://127.0.0.1:8188` |
| `BNE_OUT` | B 路线 | prepare 传给作品 `sound.py` 的输出 wav 路径，不要手动设 | 由 prepare 设置 |
| `BNE_DUR` | B 路线 | prepare 传给 `sound.py` 的片长（秒） | 由 prepare 设置 |
| `BNE_FILM` | B 路线 | prepare 传给 `sound.py` 的作品目录 | 由 prepare 设置 |
| `RAEA_EXPORT_CACHE` | B 路线（原生运行时） | 运行时的导出缓存开关；验收时设 0 | 运行时默认 |
| `RAEA_BAKE_WORKERS` | B 路线（原生运行时） | 运行时的烘焙并发；逐帧比对时设 1 | 运行时默认 |
| `LEMO_ANGLE` | C 路线历史复刻 | 风格库甲（`cases/vendor/lemo-opuscar`）渲染核心的 ANGLE 后端，作用同 `BEIMING_ANGLE` | 该库默认 |
| `PLAYWRIGHT_CHROME` | C 路线历史复刻 | 风格库甲渲染核心的浏览器可执行文件，作用同 `BEIMING_CHROME` | 该库默认 |
| `RENDER_SLOTS` | C 路线历史复刻 | 风格库甲渲染核心的整机并发名额 | 该库默认 |
| `HWGPU` | C 路线历史复刻 | 风格库乙（`cases/vendor/sy-style-100`）的 `render.js` 设 1 才用显卡，等同 `--hwgpu` | 不设时软件渲染 |
| `PLAYWRIGHT_BROWSERS_PATH` | 安装与镜像（playwright） | 浏览器安装目录；设成仓库内 `.cache/ms-playwright` 可避免与别的项目共用全局缓存 | macOS `~/Library/Caches/ms-playwright`；Linux `~/.cache/ms-playwright`；Windows `%LOCALAPPDATA%\ms-playwright` |
| `PLAYWRIGHT_DOWNLOAD_HOST` | 安装与镜像（playwright） | 浏览器下载镜像 | cdn.playwright.dev |
| `UV_DEFAULT_INDEX` | 安装与镜像（uv） | uv 的 PyPI 镜像地址（旧名 `UV_INDEX_URL` 也认） | https://pypi.org/simple |
| `UV_PYTHON_INSTALL_MIRROR` | 安装与镜像（uv） | uv 下载 Python 3.12 的镜像 | uv 默认 |
| `PIP_INDEX_URL` | 安装与镜像（pip） | 没有 uv 时 pip 的 PyPI 镜像地址 | https://pypi.org/simple |
| `npm_config_registry` | 安装与镜像（npm） | npm 镜像地址 | https://registry.npmjs.org/ |
| `BEIMING_MACHINES` | 远程工作站（tools/remote） | 机器档案文件的路径；档案放仓库外，主机名不进仓库 | `$XDG_CONFIG_HOME/beiming/machines.json`，未设时 `~/.config/beiming/machines.json` |
| `XDG_CONFIG_HOME` | 远程工作站（tools/remote） | 机器档案默认所在目录 | `~/.config` |

## 渲染器 × 环境变量

同一台机器上有三套页面渲染器，各认各的变量。设了 `BEIMING_ANGLE` 去复刻 C 路线的历史作品，是不起作用的。

| 渲染器 | 用在哪里 | GPU 后端 | 浏览器 | 并发 |
|---|---|---|---|---|
| `engine/render`（本仓库） | A、C 新作品，《北冥》 | `BEIMING_ANGLE` | `BEIMING_CHROME` | `--workers`、`WORKERS` |
| 风格库甲的渲染核心 | C 路线 66 部历史作品的 `build.sh` | `LEMO_ANGLE` | `PLAYWRIGHT_CHROME` | `RENDER_SLOTS` |
| 风格库乙的 `render.js` | C 路线 20 种方法模板 | `--hwgpu` 或 `HWGPU=1`（不设就是软件渲染） | 该库默认 | — |
| 原生运行时（B） | B 路线 | `WGPU_BACKEND` | 不用浏览器 | 运行时自己管理 |

在 NVIDIA 工作站上复刻历史作品时，三套变量要一起设：

```bash
export BEIMING_ANGLE=vulkan LEMO_ANGLE=vulkan HWGPU=1
```

```powershell
$env:BEIMING_ANGLE = 'vulkan'; $env:LEMO_ANGLE = 'vulkan'; $env:HWGPU = '1'
```

## 镜像与离线安装

| 下载什么 | 镜像怎么设 | 离线怎么办 |
|---|---|---|
| npm 包 | `npm_config_registry=<镜像地址>` | 把同平台联网机器上的 npm 缓存目录（`npm config get cache`）拷过来，设 `npm_config_offline=true` 再跑 setup |
| 无头浏览器 | `PLAYWRIGHT_DOWNLOAD_HOST=<镜像根地址>`（镜像要保留 `builds/cft/<版本>/…` 的路径结构） | 把同平台、已装好的机器上浏览器目录里的 `chromium_headless_shell-1243` 整个拷到本机同一位置（或 `PLAYWRIGHT_BROWSERS_PATH` 指定的目录）；setup 与 doctor 认它里面的 `INSTALLATION_COMPLETE` 标记 |
| Python 包 | `UV_DEFAULT_INDEX=<镜像地址>`，没有 uv 时 `PIP_INDEX_URL`；锁文件的哈希照样校验，镜像改不了内容 | 把同平台联网机器上 uv 的缓存目录（`uv cache dir`）拷过来，用 `UV_CACHE_DIR` 指向它，设 `UV_OFFLINE=1` 再跑 setup |
| Python 3.12 本身 | `UV_PYTHON_INSTALL_MIRROR=<镜像地址>` | 同时拷 `uv python dir` 指向的目录；或先装好系统的 Python 3.12，再 `npm run setup -- --no-uv --python <它的完整路径>` |

```bash
export PLAYWRIGHT_DOWNLOAD_HOST=https://<你的镜像>
export UV_DEFAULT_INDEX=https://<你的 PyPI 镜像>/simple
npm run setup
```

```powershell
$env:PLAYWRIGHT_DOWNLOAD_HOST = 'https://<你的镜像>'
$env:UV_DEFAULT_INDEX = 'https://<你的 PyPI 镜像>/simple'
npm run setup
```

## 第一次为什么慢

- **Python**：新环境第一次 `import numpy, scipy, numba, soundfile, soxr` 要加载一批原生库，macOS 上常见 30–60 秒（实测墙钟 37 秒，其中 CPU 时间只有 1.5 秒）；第二次 1–2 秒。不是 numba 在编译：numba 编译只占约 0.2 秒。setup 装完会预先导入一次，把这笔时间提前付掉。
- **浏览器**：每次出片都要启动无头浏览器，冷启动 0.3–2 秒。4K 整片里这部分占比很小；短片和单帧预览里占比明显。
- **声音**：`engine/audio/dsp.py` 的 numba 函数带缓存（`@njit(cache=True)`），缓存写在 `engine/audio/__pycache__`；目录不可写时设 `NUMBA_CACHE_DIR`。

## 存储分层与大文件

按决定 D10：

| 什么 | 放哪里 |
|---|---|
| 源码、文档、5 MiB 以内的小素材 | git |
| 底板、采样库、母版、预览视频 | Release 资产或对象存储；仓库只存清单（地址、sha256、大小、许可、来源） |
| 渲染产物（帧、wav、mp4、接触印） | `films/<名>/out/`、`out/`，永不提交 |

- 已经在库里、超过 5 MiB 的 7 个文件登记在 [`LARGE-FILES.allow`](../LARGE-FILES.allow)，带 sha256。其它跟踪文件超过 5 MiB，或者登记过的文件内容变了，`node tools/env/large-files.mjs` 与 `repo-check` 都会失败。判定的是 git 索引，`git add` 之后、提交之前就能拦住。
- 有意替换登记过的文件（例如按 D05 重渲 `media/beiming.mp4`）之后，运行 `node tools/env/large-files.mjs --update` 刷新哈希。这个命令不会添加新条目。

## 换行与编码

- [`.gitattributes`](../.gitattributes) 让文本一律按 LF 检出，`*.ps1`、`*.bat`、`*.cmd` 用 CRLF，图片、音视频、字体、`*.npz`、`*.glb` 等标成二进制；`cases/source/`、`cases/vendor/`、`cases/licenses/` 按原字节保存，那里有些文件本来就是 CRLF，案例库按字节校验哈希。
- 旧检出里已经有 CRLF 的，doctor 的 `git.eol` 一项会给出重新检出的命令。
- Windows 上 `git config core.quotepath off`，`git status` 才会显示中文文件名，而不是 `"docs/RTX\345…"` 这样的转义。
- Python 输出编码见上文「安装：Windows」。

## sh 入口盘点

仓库里还有 5 个 POSIX sh 入口。它们是 Windows 上「PowerShell 里直接跑」的主要障碍，按下表改成 Node 或 Python 入口后，doctor 的 `shell.sh` 一项自动消失（清单的机器可读版本在 `tools/env/spec.json` 的 `shEntrypoints`，doctor 与本表同源）。

| 入口 | 属主 | 谁在调用 | 替代方案 |
|---|---|---|---|
| `build.sh` | P06 | `npm run build`；`tests/production/render-pipeline.test.mjs` | `node tools/film/cli.mjs build . --profile beiming-1040p24`；`build.sh` 留一个版本作兼容壳 |
| `audio/build.sh` | P11 | `build.sh` | Python 入口 `audio/build.py`，经 `node tools/env/py.mjs audio/build.py` 调用，由 tools/film 的混音步骤接上 |
| `engine/render/mux.sh` | P04 | `build.sh`、`engine/render/build.mjs`、`engine/render/native.mjs`、`audio/check.py`、A 模版的 `build.sh`、`tests/production/render-pipeline.test.mjs` | `engine/render/lib/mux.mjs`：参数与退出码不变；ffmpeg 经 `FFMPEG` / `FFPROBE` 解析；两遍响度用 ebur128 的结果在 Node 里算；`mux.sh` 改成调用它的薄壳 |
| `routes/a-webgl/template/build.sh` | P12 | 复制成 `films/<名>/build.sh` | `npm run film -- build films/<名>`（P06 按 `film.json` 分派），模版不再带 `build.sh` |
| `fonts/fetch_fonts.sh` | P12 | 手动运行 | `node tools/fonts/fetch.mjs`：只用 `fetch` 与 `node:crypto`，按锁定清单校验 sha256 |

给改写这些入口的人，`tools/env/` 里有现成的跨平台积木，不要再各写一套：

| 要做的事 | 用什么 |
|---|---|
| 找 Python 并运行 | `spawnPython(args)`、`resolvePython()`（[`tools/env/py.mjs`](../tools/env/py.mjs)）；命令行写 `node tools/env/py.mjs <脚本>` |
| 找 ffmpeg / ffprobe | `ffmpegBins(env)`（[`tools/env/lib/ffmpeg.mjs`](../tools/env/lib/ffmpeg.mjs)），尊重 `FFMPEG` / `FFPROBE` |
| 开工前 2 秒内确认依赖齐全 | `assertPreflight(['browser', 'ffmpeg', 'python:audio'])`（[`tools/env/preflight.mjs`](../tools/env/preflight.mjs)），不满足时抛退出码 3 的错误，提示就是修复命令 |
| 过渡期仍要调用 sh | `findSh()`（[`tools/env/lib/sh.mjs`](../tools/env/lib/sh.mjs)），Windows 上找到 Git for Windows 的 `bin\sh.exe`，不要求改 PATH |
| 带超时的子进程、整组结束 | `run()`、`killAll()`（[`tools/env/lib/proc.mjs`](../tools/env/lib/proc.mjs)） |

## 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| `ModuleNotFoundError: No module named 'numpy'` | 用了系统 Python | `npm run setup`；命令改用 `node tools/env/py.mjs …` |
| `error: externally-managed-environment` | 在 Homebrew / 发行版的 Python 上直接 pip install | 不要这样装；`npm run setup` 建仓库内的 `.venv` |
| `python3` 在 Windows 上打开应用商店或没反应 | 应用商店的空壳 | 用 `node tools/env/py.mjs`；它会跳过空壳 |
| Playwright 横幅让你执行 `npx playwright install` | 横幅不知道本仓库用的是 playwright-core 1.63.0 | 不要照做（会拉别的版本和全部浏览器），运行 `npm run setup` |
| `Executable doesn't exist at …chromium_headless_shell-1243…` | 浏览器没装，或 `PLAYWRIGHT_BROWSERS_PATH` 指向了别处 | `npm run setup` |
| 渲染很慢，日志提示 SwiftShader / 软件渲染 | 没有可用 GPU，或 ANGLE 后端不对 | doctor 看 `gpu.renderer`；NVIDIA 机器设 `BEIMING_ANGLE=vulkan` |
| Windows 上 WebGL 建不起来 | 默认 D3D11 选中了核显 | `$env:BEIMING_ANGLE = 'vulkan'`；`node tools/rtx/gpucheck.mjs` 对比各后端 |
| `set: -: invalid option`、`$'\r': command not found` | sh 脚本被转成了 CRLF | 更新到带 `.gitattributes` 的提交并重新检出（doctor 的 `git.eol` 给出命令） |
| `casebook.py check` 报 `Checksum mismatch` | 归档文件的换行被转换了 | 同上；不要就地改 `cases/source`、`cases/vendor` |
| `UnicodeEncodeError: 'gbk' codec can't encode …` | 中文 Windows 上 Python 输出被管道捕获 | 经 `node tools/env/py.mjs` 运行，或先设 `$env:PYTHONUTF8 = '1'` |
| `spawn ffmpeg ENOENT` | PATH 里没有 ffmpeg | 按上文装 FFmpeg 7 以上，重开终端；`FFMPEG` 变量目前只有部分入口识别 |
| `Unknown encoder 'libx264'` | 用了不带 libx264 的 ffmpeg（例如 Playwright 自带的那份） | 换完整构建；doctor 的 `ffmpeg.components` 会指出 |
| 第一次运行声音步骤要半分钟以上 | 新环境首次加载原生库 | 正常，第二次 1–2 秒；setup 已预先导入一次 |
| setup 报 `.venv 已存在但不能用` | `.venv` 不是 setup 建的，而且 Python 版本不对 | 确认没有要保留的东西后加 `--recreate-venv` |
| setup 拒绝改动 `node_modules` | `node_modules` 是指向别的检出的链接 | 在它指向的检出里 `npm ci`，或删掉链接后重跑 |

## 维护：改依赖

| 改什么 | 怎么做 |
|---|---|
| Python 依赖 | 改 `requirements.in` → `node tools/env/lock.mjs`（按锁文件记录的时间点重新解析；`--upgrade` 取最新）→ 提交两份文件。`lock.mjs` 会对三个目标平台各解析一次，确认都有 Python 3.12 的二进制轮子、版本一致。`node tools/env/lock.mjs --check` 只核对不写文件。 |
| playwright-core | `package.json`、`package-lock.json` 与 `tools/env/spec.json` 的 `playwright` 一起改，并按新版本 `browsers.json` 里的 revision 更新 spec；跑金标准比对后再合入 |
| Node 最低版本 | `tools/env/spec.json` 的 `node`、`.nvmrc`、`package.json` 的 `engines` 一起改 |
| 新的环境变量 | 在 `tools/env/spec.json` 的 `envVars` 与本页「环境变量」表各加一行 |
| 新的大文件 | 不进 git，见「存储分层与大文件」 |

所有命令都遵守仓库的退出码约定（0 成功、2 用法错误、3 环境不合格、4 契约或检查不通过）；`--help` 不产生任何副作用，`--json` 时 stdout 只输出一个对象。

## 远程工作站

控制机（通常是 Mac）让工作站按指定提交出片、取回成片并核对哈希，见 [RTX 工作站](RTX工作站.md)与 [`tools/remote/`](../tools/remote/README.md)。
