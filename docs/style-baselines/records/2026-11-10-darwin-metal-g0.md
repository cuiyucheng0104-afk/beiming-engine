# 2026-11-10 · G0：darwin-metal 首批回归基线与差异归因

读者｜集成负责人、改引擎的维护者　状态｜已登记，待集成负责人复核　依据｜加固计划 P08·G0；规则见 [../POLICY.md](../POLICY.md)

> 2026-11-10 晚补记：清单已从 `tests/golden/manifests/<平台键>/<集合>.json` 原样并进 `tests/golden/<平台键>/manifest.json`（内容逐项不变）；合入新底座 2a0a0f3 后复核仍逐像素一致。见 [2026-11-10-rebase-2a0a0f3.md](2026-11-10-rebase-2a0a0f3.md)。下表保留登记当时的路径。

## 登记了什么

| 集合 | 帧数 | 清单 |
|---|---|---|
| beiming-core | 44（1080 整片 40 帧 + 原生 4K 4 帧） | `tests/golden/manifests/darwin-metal/beiming-core.json` |
| lab | 60（10 个自测页 × 6） | `tests/golden/manifests/darwin-metal/lab.json` |
| templates | 12（A、C 模版各 6） | `tests/golden/manifests/darwin-metal/templates.json` |
| beiming-detail | 37（切点 ±1、声画事件帧、关键时刻、无显示层、后期中间层） | `tests/golden/manifests/darwin-metal/beiming-detail.json` |
| beiming-original-v1（认可参照） | 20 | `docs/style-baselines/beiming-original@v1/darwin-metal.json` |

- 登记提交 `abfdc83`（routes-template：8c07cb8 合进 main 的 62ad28e）。截帧在工作分支上进行，工具先核对这些集合用到的像素相关路径与 `abfdc83` 逐字节相同（`git diff` 为空），清单的 `source.renderedAt` 记实际的工作分支提交。
- 环境：Apple M5 Pro，ANGLE Metal；chromium-headless-shell 153.0.8010.12（playwright-core 1.63.0）；Node 24.13.1；three 0.170.0；FFmpeg 8.0.1。
- 复跑：`node tools/baseline/golden.mjs compare --set beiming-core,lab,templates,beiming-detail --strict` → 153/153 逐像素一致，exit 0，36.7 秒；`… compare --set beiming-original-v1 --reference beiming-original@v1 --strict` → 20/20，exit 0。

## 与合并前的差异，逐帧归因

合进 main 的 62ad28e 有意改了画面，所以新基线与合并前的 routes-template（`8c07cb8`）不同。做法：`compare --against 8c07cb8 --strict` 找出全部不一致的帧，再在 HEAD 的临时副本里把候选文件逐个还原成 8c07cb8 的版本重截，还原后与 8c07cb8 逐像素一致，就说明差异完全来自这些文件。

| 集合 | 一致 | 不一致的帧 | 差多少 | 还原哪些文件后逐像素一致 | 归因 |
|---|---|---|---|---|---|
| beiming-core 1080 | 26/40 | 0.05、0.30、0.55、0.80 秒 | 0.45–0.61% 的像素，最大差 223–227 | `src/ferry.js` | R24 渡船红绿航行灯与倒影换到正确舷侧 |
| | | 1.05–2.80 秒（8 帧） | 0.81–1.63%，最大差 219–227 | `src/ferry.js` + `engine/stage/plates.js`（只还原 ferry 时这 8 帧仍不同） | R24 + R30 鸽群黑边 |
| | | 7.30、7.55 秒 | 0.016%、0.13%，最大差 7、8 | `engine/core/stroke.js` | R66 导航线线头 |
| beiming-core 原生 4K | 0/4 | 1.6、4.0、7.6、9.9 秒 | 97.7–99.3% 的像素（纸纹、颗粒全幅变了），SSIM 0.62–0.69 | 上面三个文件 + `engine/look/{index,bloom,paper,compose,ink}.js`、`src/{shotA,main,girl}.js`、`engine/paint/light.js` | 只在 4K 生效的 R17、R19、R31、R32、R45（加上 1.6 秒的 R24、R30，7.6 秒的 R66） |
| lab | 54/60 | `lab:hud` 7.5、9.17 秒 | 最大差 4、3 | `engine/core/stroke.js` | R66（自测页画同一条导航线） |
| | | `lab:kun_peng` 0.33、1.0、3.0、3.67 秒 | ≤0.006% 的像素，最大差 2–5 | `engine/shade/surface.js` | 壁画风化分支改为只按 uniform 分支、`fwidth` 在一致控制流里求（以前分支边界上的导数未定义） |
| templates | 6/12 | `tpl:a` 全部 6 帧 | 97.5–97.9% 的像素差 1–2 级，最大差 2，PSNR 49.4 dB | `engine/look/paper.js` | 程序化纸纹的中性点改为全幅均值（以前只量左下角 128×128）；A 模版用程序化纸纹，《北冥》用图片纸纹不受影响 |
| | | `tpl:c` | 全部一致 | — | C 模版不走 `engine/look` 的纸纹 |

**无法归因的差异：0 帧。**

4K 修复的目标是「4K 缩回 1080 后与 1080 直出观感一致」。量这一点：原生 4K 用 2×2 盒式缩到 1920×1040，与同一时刻的 1080 直出比较——

| 时刻 | 合并前（8c07cb8） | 现在（abfdc83） |
|---|---|---|
| 1.6 秒 | SSIM 0.652，PSNR 30.2 dB | SSIM 0.991，PSNR 41.1 dB |
| 4.0 秒 | 0.664，30.3 dB | 0.994，42.4 dB |
| 7.6 秒 | 0.681，29.4 dB | 0.955，33.2 dB |
| 9.9 秒 | 0.601，29.5 dB | 0.985，38.6 dB |

4K 的差异与修复意图一致。7.6 秒仍最低，显示层文字和导航线在两种分辨率下各自光栅化，属预期。

另用 `--against ed11b83` 复核：现代码与 v1.0 在 4.0、9.9 秒的 1080 画面逐像素一致，差别只在 R24、R30、R66 三处，说明 v1.0 到 8c07cb8 之间的重构没有改 1080 像素。

## 确定性（同日实测）

| 对象 | 取样 | 结果 |
|---|---|---|
| 《北冥》 `. --seams --workers 4 --cuts 72,120 --random 5 --frames 0,239` | 0、59–61、71–73、119–121、126、150、179–181、232、235、239，共 18 帧 | 新页面、乱序、顺序三种渲法逐像素一致，41.7 秒 |
| A 模版 `--template a` | 0、17–20、35–37、45、53–55、69–71，共 15 帧 | 一致，22.3 秒 |
| C 模版 `--template c` | 同上 15 帧 | 一致，14.0 秒 |
| 反例夹具 `tests/golden/fixtures/stateful` | 第 5、30 帧 | 判不确定，exit 4，出差异热图 |

静态扫描默认范围（`engine/` 浏览器端代码、`films/`、三条路线的模版）0 处违规；`src/` 只有 `src/kun_bronze.js` 一处只写调试计时的 `performance.now`，已登记。

## 跨平台容差的标定数据

同日在本机用 SwiftShader（`BEIMING_ANGLE=swiftshader --gpu software-ok`）截 23 帧，与 Metal 按跨平台比较，数字已写进 [POLICY.md 第 3 节](../POLICY.md#3-平台键与容差)。SwiftShader 截这 23 帧用了 78 秒（Metal 约 5 秒）。

## 待办

- `win-vulkan`（RTX 工作站）与 `linux-swiftshader`（CI）还没有基线：在对应机器上按 POLICY 第 6 节截帧、跨平台比对、审批登记。
- 集成负责人复核本记录后，在审批记录里补一行复核（`tests/golden/approvals.jsonl` 只追加）。
