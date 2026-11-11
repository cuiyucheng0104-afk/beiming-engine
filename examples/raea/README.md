# 《北冥》10 秒原生例片（北冥原生 · BNE）

北冥原生 · BNE（Beiming Native Edition）路线的完整示范片：基于外部原生运行时 RAEA（FSL-1.1-ALv2，不随仓库分发），三个镜头、骨骼鲲、渡船与尾迹、绘画水面、按镜头摆的云、毛笔片名、事件表驱动的声音。`film.tsx` 只写这 10 秒的编排；镜头、卡片、片名、纸纹、水面 / 尾迹着色器、确定性数学都来自 `engine/native/`；准备与出片用通用入口。路线手册见 [routes/b-native/README.md](../../routes/b-native/README.md)（目录名 `raea` 是上游项目名，内部沿用）。

## 文件与调用关系

```text
film.json（唯一配置源：片长 / 帧率 / 尺寸、镜头表 shots、事件帧号、AIGC 标识、素材清单）
  → node engine/native/prepare.mjs examples/raea
      images     assets/plates 的底板（近景云的截断边烘有机软边，远景云堤两端烘圆形收边）+ 纸纹 → media/
      models     鲲：配方 tools/export-kun-browser.mjs（GPU 弯曲 → 骨骼 / morph，反照率烘焙，眼睑 UV 对齐整球）
                 渡船：通用「模块 + 导出名」src/ferry.js:createFerry
                 → engine/native/bridge/export.mjs → GLB + 结构检查 + 回读报告
      sequences  title/（A 路毛笔片名页面）→ 透明逐帧 PNG media/title/ + media/title.json
      audio      tools/sound.py（engine/audio，事件时刻读 film.json）→ media/mix.wav
film.tsx + layout.js + media/ → node engine/render/native.mjs examples/raea
      → out/<run-id>/master.mp4（原生视频轨逐位复制）+ web.mp4（交付网页版）+ run.json + check.json + qa/report.md + contact.jpg + player.html
```

| 文件 | 作用 |
|---|---|
| [film.tsx](film.tsx) | 编排：读 layout 与 film.json，摆天空、卡片、水面、鲲、渡船与尾迹、纸纹、暗角、片名 |
| [layout.js](layout.js) | 机位、站位、天空铺法、片名框（纯函数；投影函数由调用方传入，见下「常见坑」） |
| [film.json](film.json) | 片长 / 帧率 / 尺寸、事件帧号（`events`）、AIGC 标识与署名、native 素材清单 |
| [palette.json](palette.json) | 色板 |
| [title/](title/) | 毛笔片名页面：`engine/overlay/brush.js` 按笔顺写「北冥」，收笔飞白，透明背景 |
| [film.board](film.board) | 时间、画面、摄影、声音安排（与 `events` 同一张表） |
| [tools/export-kun-browser.mjs](tools/export-kun-browser.mjs) | 鲲的资产桥配方 |
| [tools/sound.py](tools/sound.py) | 片中声音事件（环境声、摆位、母带用 engine/audio） |
| [expected-assets.json](expected-assets.json) | 鲲与渡船 GLB 的回归基准（结构 + 登记平台的 sha256） |
| [tools/prepare.mjs](tools/prepare.mjs) / [tools/render.mjs](tools/render.mjs) / [tools/export-kun.mjs](tools/export-kun.mjs) / [tools/export-kun-validate.mjs](tools/export-kun-validate.mjs) | 原命令的薄入口，转到 engine/native 与 engine/render 的通用实现 |

## 1. 环境

```sh
npm run setup                                   # node 依赖、无头 Chromium（资产桥与片名页面）、仓库内 .venv（声音脚本的 numpy / scipy / soundfile / numba）
node engine/native/runtime.mjs fetch --accept-license   # 原生运行时：读过上游许可后获取并校验哈希，打印 RAEA_BIN 应设的值
export RAEA_BIN=/absolute/path/to/raea/bin/raea
node engine/native/runtime.mjs status           # 版本与可执行文件 sha256 是否与 engine/native/runtime.lock.json 一致
```

Windows PowerShell：`$env:RAEA_BIN = '<runtime-dir>\raea\bin\raea.exe'`（换成 `runtime.mjs fetch` 打印的路径）。运行时与仓库都放在**纯英文路径**下（含中文的路径曾让外部字体加载失败，见 [docs/raea/experiment.md](../../docs/raea/experiment.md)）；`WGPU_BACKEND` 默认设为 `vulkan`；工具不在 PATH 时设 `FFMPEG`、`FFPROBE`，要用别的 Python 时设 `BEIMING_PYTHON`。作品要在 git 工作树里（`git archive` 导出的目录会被运行时拒绝）。不需要 Git Bash（交付编码直接调 FFmpeg，不经 `sh`）。新入口尚未在 Windows / 5090 上重跑。

## 2. 准备素材

```sh
node engine/native/prepare.mjs examples/raea    # = npm run raea:prepare；加 --preview 另存 kun-preview.png
```

产物在 `examples/raea/media/`（不提交）：底板、纸纹、`kun.glb` / `ferry.glb` 与报告、片名逐帧 PNG、`mix.wav`、`prepared.json`（每个产物的 sha256）。资产桥用 Chromium 的软件 GL 做转换与烘焙，不占独显。细节见 [ASSET-BRIDGE.md](ASSET-BRIDGE.md)。

## 3. 原生渲染

```sh
node engine/render/native.mjs examples/raea --check-only     # 预检：运行时版本与哈希、FFmpeg、素材与 prepared.json，不启动 GPU
node engine/render/native.mjs examples/raea --at 0,111,239   # 草图帧：out/<run-id>/stills/f<帧号>.png（同样过 GPU 守卫）
node engine/render/native.mjs examples/raea                  # 出片
```

渲染前查询 ComfyUI 队列和 `nvidia-smi` 利用率，有任务就 exit 5，从不终止其他进程。产物在 `examples/raea/out/<run-id>/`，`out/latest` 写着最近一次成功的 run-id：

- `master.mp4`：原生视频轨逐位复制（不再二次有损）+ AAC 48 kHz；
- `web.mp4`：交付网页版，H.264 High / yuv420p / BT.709 有限范围（四个色彩标签写全）/ AAC 48 kHz 立体声，−14 LUFS、真峰值 ≤ −1 dBTP（档位按尺寸推断为 `beiming-1040p24`）；
- `run.json`：运行时版本与哈希、实际编码器、显卡与图形后端、全部输入与素材哈希、响度实测、逐帧哈希、各阶段耗时；
- `check.json`：运行时自带的成片检查（P0 / P1 问题即 exit 4）；`qa/report.md`：仓库的机器 QA 门（规格、色彩、响度、画面、声画、底板，硬门不通过 exit 4）；`contact.jpg` 联系表；`player.html` 本地看片页。

2026-11-10 macOS（Apple M5 Pro、Metal、VideoToolbox）实测（提交 `ca5361e`）：原生渲染 4.8 秒，全程 33–85 秒（视机器负载）；240 帧，−14.0 LUFS / −3.2 dBTP，`raea check` 无问题；机器 QA 27 过、3 提示（底板静态找边看的是原图、原生片没有页面量不了贴图密度、船笛 / 鲲鸣 / 和弦是缓起的声音只给软项）、1 个硬门 `known-issues.open`：台账 `docs/quality/known-issues.json` 里 QA-B-001（云堤直线淡出，本次已修，待 QA 包按回归命令核对后关闭）与 QA-B-002（三维物体没有空气透视，未修）仍是 open，所以目前 exit 4、run.json 记 failed。技术检查通过不等于画面通过：看 `contact.jpg` 与整片。

## 4. 如何修改

- 改摄影、站位、云、天空、片名位置：`layout.js`（`SHOTS`、`cardsFor`、`title`），改完跑 `node --test tests/native/layout.test.mjs`（逐帧核对截断边在画外、天空盖满、片名在安全区且不压鲲）。
- 改事件时刻（船笛、鲲鸣、眨眼铃、和弦、片名起笔）：只改 `film.json` 的 `events`，声音与片名一起动；再同步 `film.board`。
- 改角色动作：`ToonModel animation="Swim" time=…`；鲲的位置、昂头与片段都按一拍三（`layout.js` 的 `kun(f)`）。要新动作就改配方重导 clip，不要只挪模型整体。
- 改材质：`film.tsx` 的 `KUN_PARTS` 按材质名分组覆盖；带贴图 / 顶点色的部位不要写 `base_color`。
- 改颜色：`palette.json`。改水面 / 尾迹：`waterWesl` / `ribbonWesl` 的参数。
- 改时长或分辨率：改 `film.json` 的 `dur / size`（2D 版式按 `H/1040` 缩放，天空铺法按镜头运动自动算），同时检查 `shots` 与 `events`；渲染入口按 film.json 自动核对。镜头切点只认 `film.json` 的 `shots[].out`（`layout.js` 的 `SHOTS` 只给机位，切点由 `cuts` 传入）。
- 改底板的软边、收边、裁切：改 `film.json` 的 `images[].edge / crop / flip` 后必须重新准备（`node engine/native/prepare.mjs examples/raea --only images`）；忘了的话渲染入口发现清单指纹不符会 exit 4。

## 5. 常见坑（本片踩过的）

- **作品目录里的辅助模块不能 import 作品目录之外的文件**：原生运行时把作品模块复制到临时目录打包，只有入口 `film.tsx` 的外部相对 import 被改写；`layout.js` 因此不 import engine，投影函数由 `film.tsx` / 片名页面 / 测试传进去。
- **透明面片别开距离雾**：canary 版的预乘雾会把图片卡的透明区染成雾色，整张卡变成矩形；空气感目前靠远层底板与江面远端淡出，三维物体的空气透视还没做（QA-B-002，下一步见 B 路线手册「边界与常见坑」）。
- **云堤是一段画，两端是直线淡出**：在画内结束时烘圆形收边（`edge.round`），并让收边的半透明区落在近景云后面，别压在高楼上（楼会透出来）。缓起的声音（船笛、鲲鸣、和弦）在 `events` 上标 `sync: "soft"`，QA 只给软项。
- **天空在页面层**：要像在无穷远一样跟着镜头摇 / 仰移动（`skyShift`），否则摇镜时天空「粘」在屏幕上。
- **按镜头摆近景云**：用屏幕框 + 深度（`cardInView`）换算世界坐标，截断边放在画外；上下截断边若进画，film.json 给那条边烘软边。

## 6. 已知限制与许可

没有真人物表演；鲲的视线 / 高光已烘焙，只有眼睑有动画；城市 / 云是 2.5D 绘画面片；没有 A 路的屏幕 ID 墨线与 Kuwahara。它证明资产与运行路径可迁移、画面达到「方向正确且不粗糙」，不证明 A 路笔触已完整复现。底板由 AI 生成后人工整理，成片 comment 元数据与 `player.html` 标「含 AI 生成画面」。

本目录原创代码遵循仓库 MIT。片名用的马善政字体遵循 [fonts/LICENSE.md](../../fonts/LICENSE.md) 中的 OFL（只在准备阶段渲成 PNG，不随成片分发字体）；影片、底板和艺术资产沿用仓库保留权利的范围。外部原生运行时及其 SDK 由上游 FSL-1.1-ALv2 约束，不包含在本仓库 MIT 授权内；本仓库只把它用作内部制作层（自制影片、向客户交付成片），不分发、不复制其源码，也不作为对外的产品、SDK 或渲染服务——许可边界与 agent 规则见 [docs/rights/fsl-boundary.md](../../docs/rights/fsl-boundary.md)。
