# B · 北冥原生 · BNE 路线手册

通用原生渲染层，定位 **render anything**：作品写成一个 TSX 编排文件，由外部原生 GPU 运行时（Rust + Bevy，不随仓库分发）逐帧、确定性地渲出来。画面来源不限于《北冥》：程序化造型、外部模型、图片、视频，以及 A / C 路线的页面作品都能进同一个原生场景。

## 这条路线是什么

- **执行面**：原生运行时把 React/TypeScript 编排送进 Rust 引擎，三维走 Bevy，页面层走原生排版，GPU 合成后编码。时间只由帧号决定（`useCurrentFrame()`），同一帧重渲结果一致（实测见「验收」）。
- **仓库里的部分**：`engine/native/`（TSX 组件库 + 准备阶段工具 + 通用资产桥）、`engine/render/native.mjs`（通用渲染入口）、`routes/b-native/template/`（最小作品模版）、`examples/raea/`（《北冥》10 秒例片）。
- **运行时不在仓库里**：固定版本 `0.1.0-canary.2`，用环境变量 `RAEA_BIN` 指向它的可执行文件（安装包需完整保留 `bin/` 与 `share/`，版本声明在 `share/raea/VERSION`）。许可与来源见 `THIRD-PARTY.md`。
- **什么时候选它**：要原生 GPU、要把多种来源的画面放进一个三维空间、要骨骼 / morph 动画模型、或作品不依赖 A 路的屏幕墨线与 Kuwahara 笔触。要逐帧延续《北冥》原画风时选 A 路。

## 最快上手

在仓库根目录：

```sh
npm run setup                                    # three / playwright-core / 无头 Chromium（资产桥与页面序列帧要用）
export PYTHON=/path/to/python                    # 需 numpy scipy soundfile numba（声音脚本用 engine/audio）
export RAEA_BIN=/absolute/path/to/raea/bin/raea  # 原生运行时

node tools/new-film.mjs b 我的片子                # 从 routes/b-native/template 复制到 films/我的片子/（替换 {{NAME}} {{TITLE}}）
npm run native:prepare -- films/我的片子          # 素材进 media/：复制底板、导出道具 GLB（带 Idle 动作）、生成声音
npm run native:check -- films/我的片子            # 版本、工具、素材预检，不启动 GPU
node engine/render/native.mjs films/我的片子 --at 0,36,71   # 先渲三帧看（PNG 在 films/我的片子/out/stills/，按顺序命名）
npm run native:render -- films/我的片子           # 出片：films/我的片子/out/我的片子.mp4 + out/technical.json
```

《北冥》例片沿用原命令：`npm run raea:prepare && npm run raea:check && npm run raea:render`（成片 `examples/raea/delivery/beiming-raea-10s.mp4`）。

## 一部作品的目录

```text
films/<名字>/
  film.json      片长、帧率、尺寸 + native 段（素材清单、入口、输出、封装方式）——唯一的配置源
  film.tsx       编排：镜头、站位、时间、字幕；import '../../engine/native/index.ts' 取通用件
  palette.json   色板（film.tsx 按名字取色）
  prop.js        作品自己的造型函数（浏览器端 three.js，准备阶段导出成 GLB）
  sound.py       声音脚本（from engine.audio import …）
  README.md      三五行：改哪里、怎么出片
  .gitignore     media/ 与 out/ 不提交
  media/         prepare 生成：图片、GLB 与报告、序列帧图集与 JSON、mix.wav、prepared.json（SHA256）
  out/           native.mp4（原生编码）、render.json / 日志、成片、technical.json、stills/
```

`film.json` 的 native 段（路径相对作品目录，`to` 是 `media/` 下的文件名）：

```json
{
  "entry": "film.tsx",
  "output": "out/<名字>.mp4",
  "mux": "mux.sh",
  "images":    [{ "to": "backdrop.png", "from": "../../assets/plates/sky_dawn.png" }],
  "models":    [{ "to": "prop.glb", "module": "prop.js", "export": "createProp", "args": {}, "length": 1.6,
                  "clip": { "name": "Idle", "pose": "pose", "duration": 3, "fps": 24 },
                  "validate": { "animated": true, "clip": "Idle" } },
                { "to": "boat.glb", "from": "../../examples/raea/media/ferry.glb" }],
  "sequences": [{ "to": "screen.png", "page": "../..", "from": 3, "until": 5, "fps": 12, "size": [960, 520], "cell": [480, 260] }],
  "audio":     { "script": "sound.py", "out": "mix.wav" }
}
```

## 能力清单

**render anything：输入类型与做法**

| 输入 | 做法 | 状态 |
|---|---|---|
| 浏览器里能用 engine 搭出来的 three.js 对象（模块 + 导出名 + 参数） | `models` 写 `module / export / args`；`engine/native/bridge/export.mjs` 在无头 Chromium 里调用，材质转普通 PBR（MeshBasic 视为自发光），统一缩放，导出 GLB；`clip` 逐帧调 `pose(t)` 采样子节点 TRS 与 morph 权重 | 已实测：`src/ferry.js:createFerry` 导出与基线逐字节一致；模版 `prop.js` 带 Idle 动作导出、回读、原生出片 |
| GPU 着色器里的程序形变（不在 CPU 上的动作） | 写配方 `recipe`：用 `bridge/rig.mjs` 把 `engine/form/bend.js` 的弯曲波换成站点骨骼，`bridge/geometry.mjs` 合并实例 / morph，`bridge/bake.mjs` 烘反照率 | 已实测：鲲（`examples/raea/tools/export-kun-browser.mjs`）与基线逐字节一致 |
| 外部 GLB / glTF | `models` 写 `from`；`.glb` 复制后做结构检查，`.gltf` 只复制（外部 .bin / 贴图要列进 `images`） | `.glb` 已实测（渡船 GLB 当外部模型放进模版场景）；`.gltf` 未实测 |
| 图片 | `images` 复制；`<Backdrop>`（二维底板视差）或 `<PlateCard>`（三维面片视差） | 已实测 |
| A / C 路线的页面作品（满足 `window.DUR / render(t) / READY`） | `sequences` 写 `page`：`engine/native/sequence.mjs` 用 `engine/render/page.mjs` 逐帧渲成图集，原生端 `<SequencePlane>` 按帧号取格子 | 已实测：仓库根的《北冥》A 路页面 3–5 秒 → 24 帧图集 → 原生面片，逐帧推进 |
| 视频 | `sequences` 写 `video`：FFmpeg 按 fps 抽帧成图集 | 已实测（例片成片 4–6 秒 → 24 帧） |
| 图片序列目录 | `sequences` 写 `frames` | 代码已写，未单独实测 |

**组件库（`engine/native/`，TSX，运行时侧）**

| 模块 → 能做什么 | 仓库里的例子 |
|---|---|
| `math.ts` → 直接 re-export `engine/core/math.js` 与 `clock.js`（同一份源码，数值逐位一致）+ `sinHash`、`ease` | 例片鲲一拍三 `heldTime(f, 3, FPS)` |
| `palette.ts` → 从 `palette.json` 读色、校验十六进制、按名取色、`rgb()` 给着色器 | `examples/raea/palette.json`、模版 `palette.json` |
| `camera.tsx` → `<ShotCamera shots>`：分段机位曲线（起止 eye / at / fov + 缓动） | 例片三个镜头 `SHOTS`；模版一镜推近 |
| `layers.tsx` → `<Backdrop>` 二维底板漂移、`<PlateCard>` 三维绘画面片漂移、`<SequencePlane>` 序列帧面片、`drift()` | 例片天空 / 云 / 天际线；模版底板与雾 |
| `toon.tsx` → `<ToonModel>` GLB + 全局与分材质卡通覆盖、`<ToonMesh>` / `<ToonBox>` 带材质基本体、`place()`、`toonFromShade()`（只对应颜色语义） | 例片鲲（6 个材质分组覆盖）、渡船、栏杆 |
| `title.tsx` → `<FontFace>`、`<TitleCard>` 片名淡入、`<Caption>` 字幕条、`fadeWindow()` | 例片「北冥」片名（内嵌字体）；模版字幕 |
| `post.ts` → `paperPass()` 颗粒 + 暗角、`gradePass()` 调色（逐行对应 `engine/look/grade.js` 公式） | 例片纸面颗粒；模版调色 + 颗粒 |
| `surface.ts` → `waterWesl()` 绘画水面、`ribbonWesl()` 尾迹 / 拖痕（WESL 着色器生成） | 例片江面与渡船尾迹 |

**准备与出片工具（Node / Python，准备阶段）**

| 模块 → 能做什么 | 例子 |
|---|---|
| `engine/native/prepare.mjs` → 按 film.json 准备全部素材，写 `media/prepared.json`（SHA256） | `npm run native:prepare -- films/<名字>` |
| `engine/native/bridge/export.mjs` → 通用资产桥；也可临时导出：`--module src/ferry.js --export createFerry --length 2 --out out/x.glb` | `npm run native:bridge -- examples/raea` |
| `engine/native/bridge/validate.mjs` → GLB 二进制结构检查（访问器、权重和、骨骼、内嵌贴图、动画首尾一致） | `node engine/native/bridge/validate.mjs x.glb --expect '{"animated":true}'` |
| `engine/native/sequence.mjs` → page / video / frames → 图集 PNG + JSON | `npm run native:sequence -- page . --from 3 --until 5 --fps 12 --size 960x520 --cell 480x260 --out out/seq.png` |
| `engine/render/native.mjs` → 版本预检、素材检查、共享 GPU 检查、原生渲染、`engine/render/mux.sh` 封装、帧数 / 尺寸 / 帧率 / AAC / 完整解码核对 | `npm run native:render -- films/<名字>` |
| `engine/audio`（Python）→ 环境声、合成器件、摆位、母带响度 | 模版 `sound.py`、例片 `examples/raea/tools/sound.py` |

**未实现**（不要报告成已有）：A 路的屏幕空间 ID 墨线、Kuwahara 笔触、三色双羽化卡通材质在原生端的移植（原生只有自己的分档 toon + rim + 描边）；`gradePass` 与 A 路同参数的逐像素等价；人物表演（视线、手脚接触）；视频直接作为动态纹理（目前一律转图集）；超过 8192 像素图集的长序列；Windows / 5090 上用新入口重跑。

## 契约

- **film.json**：`{ "route": "b", "title", "dur", "fps", "size": [宽, 高], "native": {…} }`。`native.entry` 默认 `film.tsx`，`output` 默认 `out/<目录名>.mp4`，`mux` 默认 `mux.sh`。帧数契约 = `round(dur × fps)`。
- **film.tsx**：`registerRoot` 一个 `Composition`，宽高帧率与 film.json 一致（模版直接 `import film from './film.json'`）。画面只读 `useCurrentFrame()`；不用 `useState`、计时器、`Date.now`、无种子随机。全局时间 `t = f / fps`，动作相位单独量化（`heldTime`）。
- **import 路径**：原生运行时能解析作品目录之外的相对 import（`.tsx / .ts / .js / .json` 均实测），所以组件库不复制进作品，统一 `import … from '../../engine/native/index.ts'`。作品必须放在仓库内两级深的目录（`films/<名字>/`、`examples/<名字>/`）。组件库里不能 import three 或 Node 模块。
- **素材路径**：`staticFile('x')` = 作品 `media/x`；`ShaderMesh` 的纹理写项目相对路径 `'media/x.png'`。所有素材都由 prepare 放进 `media/`，渲染入口会按 film.json 与 film.tsx 里的字面量引用逐个检查。
- **资产桥**：`export(args)` 返回 `Object3D` 或 `{ group | scene | root | object, length?, pose?(t) }`；根节点不记动作；动作只在 `pose(t)` 改子节点；`loop: true` 时最后一帧用 `pose(0)` 保证首尾一致。输出名只能是 `media/` 下的 `.glb` 文件名；每个模型旁边写 `<名>-report.json`（结构检查 + 回读 + 源文件哈希）。
- **序列帧图集**：`{ grid: [列, 行], frames, fps, cell, source, sha256 }`；`<SequencePlane sheet={…}>` 第 n 帧 = `floor((t − start) · fps)`，`loop` 取模，否则夹在首尾。
- **声音**：`audio.script` 由 prepare 调用，环境变量 `BNE_OUT`（输出 wav）、`BNE_DUR`、`BNE_FILM`，`PYTHONPATH` 指向仓库根。封装时 `mux.sh` 两遍线性 loudnorm 到 −14 LUFS / −1.2 dBTP。没有 `audio` 时成片无声，technical.json 会写明。
- **失败语义**：版本不对、缺素材、ComfyUI 队列有任务、`nvidia-smi` 利用率 > 10%、输出帧数 / 尺寸 / 帧率 / 音轨 / 时长不符，一律非零退出并说明原因；从不终止其他进程。

## 验收

每次改动都要有实际跑过的命令和结果（macOS / Apple M 系列 GPU / VideoToolbox 编码，2026-11-09）：

| 项 | 命令 | 结果 |
|---|---|---|
| 原生渲染可复现性 | 同一源码渲两次，逐帧解码比对 | 240 帧中 197 帧逐像素相同，最大差 6/255，最低 PSNR 79.2 dB，无像素差 > 8 → 以后用「最大差 ≤ 8、PSNR ≥ 70 dB」作阈值 |
| 例片重构前后 | `npm run raea:prepare / raea:check / raea:render`，原生视频与基线逐帧比对 | 198/240 相同，最大差 6，最低 PSNR 82.3 dB（在可复现误差内） |
| 鲲 / 渡船 GLB | prepare 后看 `media/prepared.json` | SHA256 与重构前基线逐字节一致：`75b00f72…41dd`、`1c627f59…173e` |
| 成片契约 | `technical.json` | 1920×1040、24fps、完整解码 240 帧、AAC、10.000 秒 |
| 封装差异 | 成片与基线成片逐帧比对 | `mux.sh` 用 x264 crf 19 重编码画面：最低 PSNR 35.4 dB、中位 38.6 dB（颗粒区最明显）；`--mux copy` 画面逐位保留：197/240 相同、最大差 6 |
| 模版 | 复制到 `films/demo-b` → prepare → render | 1920×1080、24fps、72 帧、AAC、3.000 秒；关键帧看到底板、雾面片视差、浮标灯卡通描边与 Idle 起伏、风标转动、字幕淡入淡出 |
| render anything | 模版加 `sequences`（A 路页面 + 视频）与外部 GLB | 页面 3–5 秒 → 24 帧 4×6 图集，原生面片上手部动作逐帧推进并循环；视频图集与外部渡船同场出片 |

看片规则：技术检查通过 ≠ 画面通过。至少抽 `--at` 关键帧与 4fps 帧条看构图、动作、片名 / 字幕、黑场与静帧；原生速度与画风质量分别评价，不把 A 路的 WebGL 数据当成原生证据。

## 边界与常见坑

- **GLB 不带屏幕后期**：A 路的屏幕描边、墨线抖动、Kuwahara、视角相关卡通光都不在模型里；原生端用 `ToonMaterial` 重新给光。覆盖材质时保留 `baseColorTexture` 与 `COLOR_0`：带贴图 / 顶点色的部位不要写 `base_color`，否则体色、眼睛纹样会被纯色盖掉。
- **透明面片别开距离雾**：canary 版的预乘雾会露出面片矩形边缘（例片因此关雾）。天空用二维 `Backdrop` 叠 `Canvas3D layered`。
- **字体**：外部字体在 Windows 中文路径下曾加载失败；要跨机一致就像例片一样内嵌 data URL（`examples/raea/title-font.ts`）。模版字幕用系统字体，换机器字形可能不同。
- **Composition 的 id 只能是字母、数字、连字符**：中文作品名不能当 id（运行时会拒绝），模版固定写 `id="film"`；作品目录名可以是中文（已实测 `films/测试片`）。
- **`--at` 的 PNG 按顺序命名**（`frame-00000.png` 对应 `--at` 里的第一个帧号），不是按帧号命名。
- **图集上限**：最长边 8192 像素，整张进显存；长视频请缩小 `cell`、降低 `fps` 或拆成几段。
- **`mux.sh` 会重编码画面**（x264 crf 19），要和原生渲染逐帧比对、或交付 master 画质时用 `--mux copy`。Windows 需要 `sh`（Git Bash）才能跑 `mux.sh`。
- **资产桥用软件 GL**（SwiftShader）：只做转换与反照率烘焙，不占独显；烘焙结果依赖这一路径，换成硬件 GL 可能改变贴图字节。
- **原生 GPU 与编码器分开记录**：macOS 实测编码器是 VideoToolbox；Windows canary 默认 OpenH264 软件编码，不能写成 NVENC / DLSS。共享工作站先看队列再渲。
- **换运行时版本**：渲染入口只放行 `0.1.0-canary.2`；新版本先重跑本节全部验收，再用 `BNE_ALLOW_VERSION` 放行。
- **对外命名**：对外只叫「北冥原生 · BNE」；`raea` 只留在 `examples/raea`、`raea:*` 命令、`RAEA_BIN` 与 `import … from 'raea'` 这些技术标识里。

## 参考作品

- `routes/b-native/template/`：最小作品（程序化 GLB + 图片底板 + 雾面片 + 字幕 + 声音），新作品从这里复制。
- `examples/raea/`：《北冥》10 秒例片——三个镜头、骨骼鲲（配方导出）、渡船（通用导出）、绘画水面与尾迹着色器、片名、`engine/audio` 声音；只写编排的 `film.tsx` 是组件库的完整用法示范。资产桥细节见 `examples/raea/ASSET-BRIDGE.md`。
- 原生运行时自带的写作指南：`$(dirname $RAEA_BIN)/../share/raea/skills/raea/SKILL.md` 与 `raea guide bevy`（三维组件全集）。
