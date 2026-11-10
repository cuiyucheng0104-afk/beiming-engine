# 金标准与认可参照规则

读者｜改引擎、改样片、改路线模版的维护者与 agent　状态｜生效（2026-11-10）　依据｜决定 D05、D08、D10；差距 QUAL-01、QUAL-10、CRAFT-10、GAP-12、ENV-02、ORCH-08

一句话：**改了会出画面的代码，合入前先证明「没把画面改坏」**。工具是 `tools/baseline/golden.mjs`（金标准）和 `tools/baseline/determinism.mjs`（确定性），两者都不需要装新依赖，`--help` 看全部参数。

## 1. 两种参照，分开存放

| | 回归金标准 | 认可参照 |
|---|---|---|
| 回答的问题 | 这次改动有没有把画面改坏 | 画风有没有偏离用户认可的那一版 |
| 用什么渲 | 现代码（最近一次经审批登记的提交） | 冻结在登记那一刻的提交 |
| 存在哪 | `tests/golden/<平台键>/manifest.json`（一个平台一份，含该平台登记过的全部集合） | `docs/style-baselines/<名>@v<版本>/<平台键>.json`，外加关键帧图 `keyframes/` |
| 画面有意改了 | `golden update` 更新（另一台机器采集的候选用 `golden approve` 转正），留审批记录 | **不改**；用户认可了新画面就另立 `@v<版本+1>` |
| 怎么比 | `golden compare --set <集合>` | `golden compare --set <集合> --reference <名>@v<版本>` |

公开成片 `media/beiming.mp4`（以及由它派生的 `media/preview.gif`、`media/beiming-1280.mp4`）**两种参照都不是**：它是 v1.0 提交前一个噪声实现初稿的残留产物，和任何一个提交的代码都对不上（调查见 [records/2026-11-10-d05-media-provenance.md](records/2026-11-10-d05-media-provenance.md)）。它只作「历史公开成片」保留；别拿它校准颜色、别为了贴近它去改着色器。

## 2. 仓库里存什么（D10）

- **只存清单**：每帧的像素哈希、PNG 字节哈希、尺寸、时刻、查询串、裁切框，外加平台键、设备、渲染器串、浏览器版本、Node / playwright / three 版本、源提交、审批。清单由工具生成，`framesDigest` 防手改。
- **像素哈希**：`sha256("RGB8 <宽>x<高>\n" + RGB 字节)`，只看像素、不看 PNG 压缩参数，所以浏览器换了 PNG 编码器、像素没变时哈希也不变。
- **回归金标准的 PNG 永不入库**：它是渲染产物。本地缓存在 `out/golden/cache/<提交>/<系统-后端>/<集合>/frames/`，比对报告、差异热图、接触印在 `out/golden/compare/<运行编号>/`。需要给别人看时，作为 Release 附件分发（公开动作，先经用户授权），清单里的 `pngSha256` 用来校验下载。
- **唯一的例外：认可参照的关键帧**。`docs/style-baselines/<名>@v<版本>/keyframes/<名字>.png` 是冻结的认可参照的一部分（look 闸门并排对照、`lookPreset` 指向它、评测的风格参考指标从这里读），不是出片产物：只能由 `golden keyframes` 从登记提交原样导出，像素与参照清单里同名帧逐位相同，登记在同目录的 `keyframes.json`（字节哈希、像素哈希），单张不超过 5 MiB（D10）。`beiming-original@v1` 六张共 17.1 MiB，一次性入库、之后不改。规范检查 `baseline.no-render-products` 只放行这种图，`baseline.references` 逐张解码核对。
- 同一平台上，登记提交可以逐像素重现全部 PNG（2026-11-10 实测：复跑 153/153 帧逐像素一致），所以基线不依赖附件；附件只是给没有这台设备的人看。

## 3. 平台键与容差

**平台键** = `<系统>-<WebGL 后端>`：`darwin-metal`、`win-vulkan`、`win-d3d11`、`linux-swiftshader`……由 WebGL 实际报出的渲染器串判定，不看 `BEIMING_ANGLE` 写了什么（写了 vulkan 却落到核显、落到软件光栅，平台键会如实变化）。`capture` / `compare` 加 `--platform <平台键>` 时先核对：本机实际渲出的平台键不符就 exit 3（`env.platform-mismatch`），CI 用它防止「以为在比 SwiftShader，其实落到了别的后端」。设备型号（如 `apple-m5-pro`、`nvidia-geforce-rtx-5090`）不进平台键，记在清单的 `device` 里：同平台键、不同设备时哈希不同的帧会被区分为环境漂移（见下）。

**同一平台键**（同一种后端）：

1. 像素哈希与清单相同 = 通过。
2. 哈希不同 → 工具自动在本机现渲清单的源提交：本机渲出的源提交也和清单不同，说明是**环境漂移**（换了设备、驱动或浏览器），这些帧改为和本机渲的源提交比，报告里列为 `drift`；否则就是代码改了像素。
3. 再按集合的 `samePlatform` 容差判：差超过 1 个色阶的像素不超过 0.1%（即 99.9% 的像素差不超过 1 级）。`--strict` 要求逐像素一致，合入前的「像素保护」用它。

**不同平台键**（跨后端）不可能逐像素一致，只按 SSIM、PSNR 和「差超过 2 个色阶的像素占比」判。阈值按实测标定：

| 实测（全部是 1080 无损截图，RGB） | SSIM | PSNR | 差 >2 级的像素 |
|---|---|---|---|
| Metal 对 SwiftShader，《北冥》正片 10 帧（2026-11-10，本机） | 0.9974–0.9986 | 46.1–52.0 dB | 0.11–1.13% |
| Metal 对 SwiftShader，自测页 6 帧 | 0.9926–0.9995 | 41.0–54.2 dB | 0.1–8.1%（`lab:look` 最差） |
| Metal 对 SwiftShader，A、C 模版 6 帧 | 0.9982–0.9999 | 52.7–68.8 dB | 0–0.16% |
| Metal 对 SwiftShader，灰阶色卡 | 逐像素一致 | — | 0 |
| Mac 对 RTX 工作站，正片 5 个时刻（[docs/渲染与4K.md](../渲染与4K.md)） | — | 43–51 dB | 0.5–3.6% |

据此定的容差（写在 `tools/baseline/sets.json` 各集合的 `crossPlatform` 里，改了集合哈希会变）：

| 集合 | SSIM 不低于 | PSNR 不低于 | 差 >2 级的像素不超过 |
|---|---|---|---|
| beiming-core、templates | 0.985 | 40 dB | 5% |
| lab、beiming-detail、beiming-original-v1 | 0.98 | 38 dB | 12% |
| fixtures | 0.999 | 50 dB | 0.1% |

差异几乎都在显示层文字边缘和零星墨线像素上（系统的文字光栅化不同），没有文字的画面只差 1–2 级。beiming-detail 的后期中间层（`dbg=id/edge/…`）还没有跨平台实测，先按自测页的容差；第一次拿到 Windows 或 Linux 的基线时补测并改这一节。

## 4. 软件渲染：`--gpu` 策略

| 取值 | 用在哪 | 行为 |
|---|---|---|
| `required`（默认） | 本地出片、本地金标准 | WebGL 落到软件光栅（SwiftShader、llvmpipe、WARP）立刻 exit 3，一帧也不截 |
| `any` | 本地排查 | 接受任何后端，平台键照实记 |
| `software-ok` | CI 冒烟（`linux-swiftshader` 基线）、B 路线资产烘焙 | 明确要软件渲染；截帧清单的 `env.gpuPolicy` 记下来。`--platform` 指明软件光栅平台（`*-swiftshader`、`*-llvmpipe`、`*-warp`）而没写 `--gpu` 时，默认就是它 |

软件渲染的帧只会和 `*-swiftshader` 基线同平台比，和 GPU 基线之间按第 3 节的跨平台容差比，所以 CI 用 SwiftShader 不会把 GPU 基线判红，GPU 基线也不会被 CI 的软件渲染污染。

## 5. 什么时候跑

| 场合 | 命令 | 判据 |
|---|---|---|
| 改了 `engine/`、`src/`、`lab/`、`assets/`、`fonts/`、`index.html` 或路线模版，合入前（像素保护） | `node tools/baseline/golden.mjs compare --set beiming-core,lab,templates --strict` | exit 0；不是 0 就看报告里的热图和接触印 |
| 想知道是哪个提交改了像素 | `… compare --set <集合> --against <提交>` | 只把那个提交的页面（约 60 MB）导出到临时目录现渲，结束即删，不建 worktree |
| 另一台机器的画面 | 那台机器 `… capture --set <集合> --out <目录>`，拷过来 `… compare --set <集合> --ref-dir <目录>` | 按跨平台容差 |
| CI 冒烟（`tests/ci/smoke-render.mjs` 的 golden 阶段，`BEIMING_ANGLE=swiftshader`） | 有 `tests/golden/linux-swiftshader/manifest.json`：`… compare --set beiming-core --set lab --platform linux-swiftshader --json`；没有：同样参数的 `capture`，结果作为工件 `golden-capture` 上传 | compare exit 0 通过、4 像素不一致；capture 写出的是待审批候选，按第 6 节转正 |
| 新作品出片前、改了带累计状态的镜头 | `node tools/baseline/determinism.mjs films/<名> --seams --workers 4` | exit 0：新页面、乱序、顺序三种渲法逐像素一致 |
| 《北冥》样片 | `node tools/baseline/determinism.mjs . --seams --workers 4 --cuts 72,120 --random 5 --frames 0,239` | 2026-11-10 实测 18 帧通过，41.7 秒 |

确定性检查不通过（exit 4）说明 `render(t)` 里有累计状态、没设种子的随机或依赖上一帧的东西：多 worker 分段出片会在段边界跳相位。修好之前出片用 `--workers 1`。静态扫描同时检查 `Math.random`、`Date.now`、`performance.now`、`new Date`、`crypto.getRandomValues`；只用于计时打日志的写法在同一行写 `// determinism-ok: <理由>`，存量登记在 `tools/baseline/determinism-allow.json`（只减不增）。

退出码按附录 C1：0 通过；1 运行失败；2 用法错误；3 环境不满足（没浏览器、软件渲染被拒、平台键不符、本平台没有经审批的基线）；4 不通过（超容差、无法核实、缺帧、清单或集合不合法、审批前提不满足）；5 资源忙；124 超时；130 / 143 中断已清理。两个命令都用命令约定库 `tools/lib/cli.mjs`（[docs/CLI.md](../CLI.md)）：`--help` 无副作用；`--json` 时 stdout 只有一个信封对象（`schemaVersion`、`ok`、`exitCode`、`error.code`、`outputs`、`runJson`、`warnings`、`data`），`runJson` 指向第一份比对报告，人读日志走 stderr；`--quiet` 只关进度日志。

## 6. 画面有意改了：审批与更新

1. 提出改动的 PR 写一节「会改变画面的修复」：逐条写改了什么、在哪些时刻看得见，并附 `compare` 报告里对应的帧。差异帧要能一一归因到这些条目（做法见 [records/2026-11-10-darwin-metal-g0.md](records/2026-11-10-darwin-metal-g0.md)）。无法归因的差异按回归处理。
2. 集成负责人或用户批准后，在已提交的代码上更新：
   `node tools/baseline/golden.mjs update --set <集合> --by <批准人> --reason <理由> --commit <提交> --ref <PR 或原话出处>`
   - 像素相关路径有未提交改动时拒绝。
   - `--commit` 可以是 HEAD，也可以是与 HEAD 在这些集合用到的像素路径上逐字节相同的稳定提交（例如集成分支的合并基底）；这样工作分支被压扁合并后，清单里的提交仍然找得到。
   - 每次更新在 `tests/golden/approvals.jsonl` 追加一行：谁、为什么、哪个提交、更新前后的摘要、新增 / 删除 / 变化的帧。这个文件只追加。
3. **另一台机器采集的基线（CI 的 `linux-swiftshader`、没有 GPU 的人拿不到的平台）**：在那台机器上 `capture --set <集合> --platform <平台键>`，工具把截帧写成待审批候选（`tests/golden/<平台键>/manifest.json` 里该集合 `status: "candidate"`、`approval: null`，另记像素相关路径的内容摘要 `source.pixelTree`）。CI 的 smoke-render 首次运行就是这样做的，并把候选作为工件 `golden-capture` 上传。`--platform` 采集同时在截帧目录拼一张总览 `contact.png`（全部帧，4 列），审批要看的就是它和原帧。审批人下载工件、在仓库根目录解开、看过总览与原帧后转正：
   `node tools/baseline/golden.mjs approve --platform <平台键> --set <集合> --by <批准人> --reason <理由> [--commit <提交>] [--ref <出处>]`
   - 不重渲（本机渲不出别的平台的像素），只核对：候选按现在的 `sets.json` 截的（集合哈希一致）；登记提交在候选用到的像素相关路径上与采集时逐字节相同（按 `source.pixelTree` 核对，不需要采集时的提交在本地——CI 的合并提交在 PR 合入后就找不到了，这时用 `--commit` 指合入后的提交）。
   - 候选转正前不参与比对（`compare` 视为本平台没有基线，exit 3），也不能入库（规范检查 `baseline.manifests` 报错）。已有经审批基线的集合，`capture --platform` 不覆盖。
4. agent 可以替人执行 `update` / `approve`，但 `--by` 写批准人、`--reason` 引用批准出处；agent 不得给自己的画面改动当批准人（同 D08）。
5. 改 `tools/baseline/sets.json` 里某个集合（加帧、换时刻、改容差）或它引用的页面定义，会改变它的集合哈希，`compare` 会提示「集合定义已变」，同样要经审批 `update`。顶层 `annotations`（镜头表等标注）不进集合哈希。

## 7. 认可参照的版本规则

- 命名 `<风格名>@v<版本>`，例如 `beiming-original@v1`。目录里一份 `README.md`（是什么、认可依据、怎么用）和每个平台一份清单 `<平台键>.json`。
- 登记：`node tools/baseline/golden.mjs reference --set <集合> --id <名>@v<版本> --by <登记人> --reason <认可依据> --commit <提交>`。已存在的平台文件拒绝覆盖；给新平台补登记时必须用同一提交、同一份集合定义。
- 认可状态以用户的话为准：README 里引用用户原话和出处；没有原话的写「待用户确认」，不得写成「用户已认可」（D08）。
- 用户认可了新的画面 → 另立 `@v<版本+1>`，旧版本保留做历史对照。
- 关键帧：先在 `keyframes.json` 写好「名字 → 帧编号」，再 `node tools/baseline/golden.mjs keyframes --reference <名>@v<版本>`。工具现渲登记提交、逐帧核对像素与参照清单完全一致后，把原样 PNG 放进 `keyframes/` 并写下字节哈希与像素哈希；只能在参照已登记的平台上做，已有的图像素对不上就拒绝。
- `film.json` 里延续某个风格时写 `"style": { "id": "beiming-original", "version": 1 }`，镜头的 `lookPreset` 指向参照里的关键帧，例如 `beiming-original@v1/wide`（各关键帧的名字见该参照的 README）。

## 8. 集合一览（2026-11-10，Apple M5 Pro / Metal 实测耗时）

| 集合 | 帧数 | 内容 | 截一遍 |
|---|---|---|---|
| beiming-core | 44 | 《北冥》1080 整片 40 帧（t = 0.05 + 0.25·i）+ 原生 4K 4 帧（1.6、4.0、7.6、9.9 秒） | 约 15 秒 |
| lab | 60 | 10 个自测页各 6 帧（t = (i + 0.5)·DUR / 6） | 约 14–18 秒 |
| templates | 12 | A、C 路线模版各 6 帧，按 film.json 画幅 | 约 3–4 秒 |
| beiming-detail | 37 | 两个切点 ±1 帧、声画事件帧、六个关键时刻、无显示层、五个后期中间层 | 约 15 秒 |
| beiming-original-v1 | 20 | 认可参照 beiming-original@v1 | 约 11–17 秒 |
| fixtures | 5 | 测试夹具：纯函数画布页、灰阶色卡（截图链路本身是否改色） | 约 2 秒 |

已有基线：`darwin-metal` 上 beiming-core、lab、templates、beiming-detail 四套（登记提交 abfdc83；11-10 晚在合入 P01/P02/P07/P09/P10/P17 的底座 2a0a0f3 上复核 153/153 逐像素一致，见 [records/2026-11-10-rebase-2a0a0f3.md](records/2026-11-10-rebase-2a0a0f3.md)）。**还没有**：`win-vulkan`（RTX 工作站）、`linux-swiftshader`（CI 首跑采集候选后按第 6 节第 3 条转正）。

## 9. 与色彩链、编码的关系

金标准截的是页面画布（`--force-color-profile=srgb` 下的 PNG），在任何视频编码之前。改视频编码的色彩（例如 62ad28e 把成片改为 BT.709 限范围并完整标注）不改变金标准；反过来，金标准零差异是色彩相关 PR 的必要证据。成片的色彩、响度、规格由 QA 门（`tools/qa`）按显式参数解码检查，不靠金标准。
