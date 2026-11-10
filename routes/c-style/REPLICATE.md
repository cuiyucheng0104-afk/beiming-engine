# C 路线 · 历史复刻：把我们做过的一部原样重渲

适用于 `cases/` 里的 66 部风格实验（每部对应 86 式里的一式 Lemo 风格），以及想把 SY 风格的示例页交给北冥渲染器的时候。新片不走这里，用 [C 模版](template/README.md)。

## 三条原则

1. **只用固定快照。** 上游风格库按 `cases/vendor/lock.json` 锁定的提交（lemo-opuscar@bebbbe1、sy-style-100@e41dee3）运行，不联网拉代码。大素材（采样乐器等）也按快照里锁好的 sha256 下载，校验不过就不用。
2. **不改归档，不碰家目录。** `cases/vendor/`、`cases/source/` 只读；运行环境建在 `out/runtime/` 下；`~/lemo-opuscar` 不读不写。
3. **不要运行 vendor 自带的 `setup.sh`**（`cases/vendor/lemo-opuscar/plugin/skills/lemo-opuscar/scripts/setup.sh`）。它会去找或克隆 `~/lemo-opuscar`，对自己管理的克隆执行 `fetch origin main` 和 `reset --hard`，拿到的是上游最新代码而不是固定快照。上游 `tools/fetch.sh` 出错时也会提示你跑它——别跑，按下面的表处理。

## 先看是哪一类

在 [STYLES.md](STYLES.md) 找到那一式（或 `node tools/c-styles.mjs find <关键词>`），看"契约 · 历史渲染器"和"自包含"两列：

| 类别 | 有多少 | 怎么渲 |
|---|---|---|
| 自包含的 Lemo 页面 | 22 部 | 完整复刻用 `c-runtime build`；只要画面也可以直接交给 `engine/render`（见第 5 步） |
| 依赖 `/core/` 的 Lemo 页面 | 44 部 | 页面里有 `/core/` 绝对路径，只能在 Lemo 库根目录下服务：用 `c-runtime build` |
| SY 风格（`__seek` 契约） | 20 种，没有我们的成片 | `c-runtime sy` 生成适配页，再交给 `engine/render` |

## 步骤（Lemo）

**1. 建隔离运行时**（一次就好，约 1 秒；会核对快照的 2478 个文件）：

```bash
node tools/c-runtime.mjs setup                  # Python 按仓库统一的顺序选（node tools/env/py.mjs --which 可查看），也可以用 --python 指定
#   → out/runtime/lemo-bebbbe1a/（快照副本 + 链到仓库根 node_modules + .venv/bin/python 转发脚本 + runtime.json）
node tools/c-runtime.mjs status                                                       # 只读核对
```

缺 Python 包时它会停下，列出缺什么。解决办法三选一：在仓库根运行 `npm run setup`，按锁文件建好仓库 `.venv`；或者用 `--python` 换一个装好包的解释器；或者加 `--venv`，在运行时里建虚拟环境并按上游 requirements 安装（要联网）。拨弦乐器（`pluck.py`）要 numba，加 `--music` 一并检查。

**2. 还原作品**（必须带 `--download`：`--source-only` 不带图片、字体等二进制素材，不能出片，也不能拿它判断能不能渲）：

```bash
node tools/env/py.mjs tools/casebook.py restore style-76-circuit-board --download --lemo out/runtime/lemo-bebbbe1a
#   → out/casebook/style-test-66/76-circuit-board/；素材包每个约 0.6 GB，一部要 1–3 个，下到 out/casebook-packs/（--packs 可改）
```

`--lemo` 不写时 build.sh 里的 `LIB` 会指向 `cases/vendor/lemo-opuscar`；`c-runtime build` 反正会把它改指运行时，但写上更清楚。

**3. 装采样乐器**（多数作品的配乐用到）。先空跑一遍，它会按作品的声音脚本查出要哪几个采样库：

```bash
node tools/c-runtime.mjs build out/casebook/style-test-66/76-circuit-board --dry-run
node tools/c-runtime.mjs assets instruments-vcsl                # 按上一步的提示装；几百 MB 一个，断了重跑会续传
```

**4. 复刻：**

```bash
node tools/c-runtime.mjs build out/casebook/style-test-66/76-circuit-board
```

它把 build.sh 的 `LIB=` 改指运行时、`"$LIB/.venv/bin/python"` 换成运行时记下的解释器，写成同目录的 `build.c-runtime.sh` 再用 `sh` 运行；跑完按 `cases/catalog.json` 记录的成片规格核对宽高、帧率、帧数，不符退出码 4；运行记录写在 `<还原目录>/out/c-runtime-run.json`。默认 3600 秒超时（`--timeout`），超时或 Ctrl-C 会结束整个进程组。

**5. 只要画面（自包含的页面）**：Lemo 页面与北冥同一套页面约定（`DUR` / `render(t)` / `READY`），只是不声明 `window.FPS`，所以按原帧率渲、非 24 fps 时加 `--any-fps`：

```bash
node engine/render/video.mjs out/casebook/style-test-66/04-impasto --size 1920x1080 --fps 24 --out out/casebook/style-test-66/04-impasto/out/engine-video.mp4
```

还原目录必须在仓库内（`engine/render` 只服务仓库根）；有的作品要先跑它 build.sh 里的准备步骤（生成纸纹图、导出时间表等）才能渲。

## 步骤（SY）

```bash
node tools/c-runtime.mjs sy 18 --still 2,8.5        # 适配页 + 两张静帧
node tools/c-runtime.mjs sy 18-ink --video          # 适配页 + 整片（帧率、片长取页面的 __fps、__duration）
#   → out/runtime/sy-e41dee31/18-ink/index.html、out/stills/、out/video.mp4
```

适配页原样取自只读快照，只加三样：指回快照目录的 `<base>`、在 SY 的 `core.js` 读地址前补上 `?render=1`（否则它按墙钟循环播放）、把 `__duration` / `__fps` / `__seek` 挂成 `window.DUR` / `FPS` / `render` 并在第 0 秒画好后置 `READY`。SY 页面用本机字体名（Noto CJK、Inter 等），字体不随库分发，换机器字形就变；页面没有经过北冥的确定性核对。SY 自带的 `render.js` 需要 `playwright` 包（仓库只装了 `playwright-core`），且默认软件渲染，仓库不提供这条路。

## 平台

三套渲染器各认各的环境变量，变量表与三平台写法见 [docs/ENVIRONMENT.md「渲染器 × 环境变量」](../../docs/ENVIRONMENT.md)。

- **macOS / Linux**：自带 `sh`。在 Linux 或 Windows 上用 NVIDIA 显卡时，设 `LEMO_ANGLE=vulkan`（Lemo 渲染器）和 `BEIMING_ANGLE=vulkan`（北冥渲染器），否则 Chrome 可能落到核显或软件渲染。
- **Windows**：历史作品的 build.sh 是 POSIX shell 脚本，需要 `sh`。装 Git for Windows 后，`c-runtime` 会自己找到 `Git\bin\sh.exe`（装在别处时设 `BEIMING_SH`），也可以在 WSL 里跑。运行时的 `node_modules` 用目录联接，不需要管理员权限。新片和 SY 适配页不需要 `sh`。
- **Windows 上的解释器路径**：`c-runtime build` 已把 build.sh 里的 `"$LIB/.venv/bin/python"` 换成运行时记下的解释器，脚本里直接写 `.venv/bin/python` 的地方由 sh 小脚本转发。但个别作品的 Python 代码会自己拼 `$LIB/.venv/bin/python` 起子进程，例如 `style-34-silent-film` 的 mix.py。Windows 上没有这个可执行文件，这类作品要在 WSL 里复刻。

## 出错了

| 退出码 | 意思 | 下一步 |
|---|---|---|
| 2 | 用法错误（目录不存在、风格编号不对） | 按提示改参数 |
| 3 | 环境缺东西：运行时没建、Python 缺包、缺采样库、找不到 `sh` / ffmpeg、仓库根 node_modules 版本与上游锁定的不一致 | 按提示 `setup` / `assets` / 装工具；根 node_modules 用 `npm ci` 装 |
| 4 | 核对不通过：快照被改过、源码模式还原、还原标记没替换（如 `@@ROG_HOST@@`）、成片规格与案例目录不符 | 快照用 `git checkout -- cases/vendor` 恢复；带 `--download` 重新还原；依赖外部机器或服务的作品不能在这里复刻 |
| 1 | 历史脚本或渲染本身出错 | 看日志第一处报错；`ModuleNotFoundError` 换解释器，缺素材检查还原是否带了 `--download` |
| 124 / 130 / 143 | 超时 / 被中断 | 子进程已全部结束；加大 `--timeout` 重跑 |

不在复刻范围内：要联网服务的步骤（在线 TTS、外部素材下载如 `material/urls.txt`）、`@@ROG_HOST@@` 这类指向别的机器的作品、PPT 与发布会片（各有自己的流程，见 [docs/cases/ppt-animation.md](../../docs/cases/ppt-animation.md)）。

## 实测记录（2026-11-10，macOS，Apple M5 Pro，Metal）

| 案例 | 类别 | 结果 |
|---|---|---|
| `style-76-circuit-board`《叮咚》（电路板风格） | 依赖 `/core/` | `c-runtime build` 退出码 0，用时 34 秒：1920×1080、30 fps、594 帧，与案例目录一致；成片 −14.0 LUFS，拍点核对 41 个打点最大偏差 0.5 ms，读字检查通过；与归档预览片按同一时刻比对（缩到 960×540）PSNR 33.0–37.6 dB |
| `style-04-impasto`《红色自行车》（油画厚涂） | 自包含 | 装好它要的三个采样库（vcsl、vsco2ce、freepats）后 `c-runtime build` 退出码 0，用时 29 秒：1920×1080、24 fps、468 帧，与案例目录一致，成片 −13.8 LUFS，拍点核对最大偏差 0.2 ms；另用 `engine/render` 直接渲画面也是 468 帧，15.417 秒那一帧与归档海报 PSNR 36.7 dB |
| `sy/18-ink`（水墨国风） | SY | `c-runtime sy 18-ink --video` 退出码 0，用时 9 秒：1920×1080、30 fps、300 帧（= 10 秒 × 30），BT.709 有限范围 |

以上只说明"能按固定快照重渲、规格与归档一致"，不是对作品的认可。
