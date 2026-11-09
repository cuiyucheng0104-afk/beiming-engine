# A · 北冥风格路线 · WebGL 三渲二

> 路线手册。第一次进仓库、要用这条路线做片，读完这一份就能开工。三条路线怎么选见 [routes/README.md](../README.md)。

## 这条路线是什么

用代码做**确定性的三渲二短片**：三维程序化造型 + 三档卡通着色 + 屏幕空间手绘墨线 + Kuwahara 颜料笔触 + 二维手绘/程序化底板的透视视差 + 不过后期的显示层（片名、字幕、界面）。画面在无头 Chrome 的 WebGL（Three.js r170）与 Canvas 2D 里画，逐帧截图交给 FFmpeg 编码。

- 执行面：无头 Chrome + WebGL（ANGLE，macOS 默认 Metal，RTX 机器用 Vulkan）+ Canvas 2D；声音用 Python（numpy/scipy）离线合成；FFmpeg 封装。
- 画风由三处代码共同决定：造型（`engine/form`）、着色（`engine/shade`）、后期（`engine/look`）。换画风换的是参数与着色器，不是换素材。
- 每一帧都是时间 `t` 的纯函数：任意一帧能单独重渲，分段并行渲染不改变画面。
- 适合：延续《北冥》画风、新的风格预设、需要精确控制色阶 / 阴影 / 墨线 / 纸纹 / 二维三维比例的作品。
- 不适合：要原生 GPU 执行、骨骼角色大量表演、不要北冥美术规则的通用场景 → 走 [B · 北冥原生 · BNE](../b-native/README.md)；只想借一种成熟的代码画法 → 先查 [C · 86 式](../c-style/README.md)，再回来落地。

## 最快上手

在仓库根目录执行（第一次需要 `npm run setup` 装 three、playwright-core 和无头 Chrome；声音需要 `requirements.txt` 里的 Python 包）：

```sh
node tools/new-film.mjs a my-film --title 我的短片        # 复制 routes/a-webgl/template → films/my-film/
node engine/render/still.mjs films/my-film 0 1.5 2.9 --out films/my-film/out/stills   # 先看三张关键帧
sh films/my-film/build.sh                                  # 关键帧 → 声音 → 逐帧视频 → 音画封装 → ffprobe
```

- 成片：`films/my-film/out/film.mp4`（1920×1040、24 fps、72 帧、48 kHz 立体声 AAC）。
- 没装 Python 依赖时先只出无声视频：`node engine/render/video.mjs films/my-film --out films/my-film/out/video.mp4`。
- 指定 Python：`PYTHON=/path/to/python sh films/my-film/build.sh`；原生 4K：`sh films/my-film/build.sh --size 3840x2080`（构图不变，引擎按高度放大）。
- 改哪里：`film.json`（时长、帧率、画幅、片名）→ `main.js` 里的色板 `C`、造型、着色参数、底板、镜头运动、后期参数 `lookAt`、片名 `drawTitle` → `sound.py`。
- 改完跑 `npm run check:repo`。

## 一部作品的目录

`node tools/new-film.mjs a <名字>` 生成：

```
films/<名字>/
  film.json     { "route": "a", "title": 标题, "dur": 秒, "fps": 24, "size": [宽, 高] }；main.js、sound.py、build.sh 都读它
  index.html    页面入口：importmap 把 three 指到仓库根的 /node_modules，再加载 main.js
  main.js       整部片：createFilm 外壳、镜头表、造型、着色、底板、后期参数、显示层
  sound.py      声音：engine/audio 合成 → out/mix.wav（48 kHz、立体声、24 bit）
  build.sh      一键出片（在任何目录调用都行，内部切到仓库根）
  README.md     三五行：改哪里、怎么出片
  out/          成片与中间文件（stills/、mix.wav、video.mp4、film.mp4），被 .gitignore 忽略，不提交
```

片子长了按镜头拆文件：`shotA.js`、`shotB.js` … 各自 `export function buildShotX(...) → { scene, camera, update, look }`，`main.js` 只留镜头表与显示层（照 `src/main.js` 的写法）。自有底板图放 `films/<名字>/plates/`，用 `loadPlates(names, { dir: './plates' })` 读（需要一份 `plates.json`，格式见 `assets/plates/plates.json`）。

路径一律按 `films/<名字>/` 这个深度写：引擎是 `../../engine/`，字体是 `../../fonts/`，three 走 importmap 的绝对路径 `/node_modules/...`。

## 能力清单

格式：模块 → 能做什么 → 仓库里的例子。接口细节以各文件开头的中文注释为准（`npm run check:repo` 保证每个模块都有）。

**core · 时间与数学**（纯函数，任意帧可单独重渲）
- `engine/core/clock.js` → 帧号、一拍一 / 二 / 三量化（`frameOf / hold / heldTime / tick`）→ `src/shotA.js`、`src/shotC.js`、模版 `main.js` 的墨线时钟
- `engine/core/math.js` → `clamp / lerp / seg / ss / eio` 缓动、确定性随机 `mulberry(种子)`、整数哈希、单调样条 → 几乎所有 `src/*.js`
- `engine/core/noise.js` → 2D / 3D 单纯形噪声（种子决定置换表）→ `src/kun.js`、`src/girl.js`
- `engine/core/stroke.js` → 带笔压的中心线 → 有粗细起伏的墨线轮廓多边形 → `src/hud.js`

**form · 程序化造型**（Three.js 几何体，随机只来自种子）
- `engine/form/loft.js` → 轮廓表放样长条形体（超椭圆截面）、翼 / 鳍放样、体表展开 UV → `src/kun*.js`
- `engine/form/bend.js` → 游动行波弯曲：GLSL 顶点钩子 + 同公式 JS 镜像（挂件、眼睛跟着弯）→ `src/kun.js`
- `engine/form/eye.js` → 眼珠 + 上下眼睑：眨眼、注视、眼窝挂载 → `src/kun.js`
- `engine/form/curves.js` → Catmull-Rom、圆 / 方旋涡（回纹）、路径转 Shape、变径管 → `src/kun_bronze.js`
- `engine/form/plants.js` → 飘带叶、草簇、蕨、松、叶片 / 鳍片 → `src/kun.js`、`src/kun_qinglv.js`
- `engine/form/props.js` → 团块、藤壶、扇贝、花盘、分叉珊瑚、羽片卡、船身 → `src/kun.js`、`src/ferry.js`
- `engine/form/rock.js` → 笋状尖峰 `spire`、台地 `mesa`（山水画的峰与台）→ `src/kun_qinglv.js`、模版 `main.js`
- `engine/form/scatter.js` → 按顶点权重在网格表面确定性撒点、打成实例化网格 → `src/kun.js`
- `engine/form/sdf.js` → 画布蒙版 → 有符号距离场（纹样凹凸、离缘距离）→ `src/kun_bronze.js`

**shade · 卡通着色**（three r170 内置材质打补丁）
- `engine/shade/toon.js` → 三档分档、投影量化、背光 / 受光硬边边缘光、下方补光、天空冷光；`toonKind` 一族材质共享着色器、各有物体 ID → `src/toon.js`（《北冥》色板与预设）、模版 `main.js`
- `engine/shade/surface.js` → 物体空间表面层：锈斑 / 藻斑 / 斑点（`patchLayer`）、绘画感笔触（`paintLayer`）、壁画风化（`muralLayer`）→ `src/toon*.js`
- `engine/shade/patch.js` → 往内置材质注入着色器片段（锚点缺失直接报错）、带同样形变的阴影深度材质 → `src/toon_qinglv.js`
- `engine/shade/noise.glsl.js`、`engine/shade/util.glsl.js` → GLSL 噪声 / fbm / Voronoi；抗锯齿阈值、细线、远景淡出、无切线凹凸 → `src/toon_bronze.js`、`src/toon_xuan.js`

**stage · 镜头与舞台**
- `engine/stage/film.js` → 影片外壳：渲染器（sRGB 输出、不做色调映射、软阴影）、显示层画布、设计尺寸缩放 K、按时间切镜头、兑现页面约定 → `src/main.js`、模版 `main.js`
- `engine/stage/camera.js` → 摆相机（不歪地平线）、屏幕像素 ↔ 世界坐标、按屏幕像素摆面片 `placeOnScreen / fillScreen` → `src/shotA.js`、模版 `main.js`
- `engine/stage/plates.js` → 底板面片（不吃雾、不描边）、读 `plates.json`、画布层 `canvasLayer`、裁切软边云片、抠像面片、加色辉光 `glowSprite` → `src/shotA.js`、`src/shotB.js`、模版 `main.js`
- `engine/stage/dome.js` → 穹顶面片：摇镜、仰拍时天空不变形 → `src/shotC.js`
- `engine/stage/motion.js` → 航向四元数、逐帧积分路径、贝塞尔采样 → `src/shotC.js`
- `engine/stage/outline.js` → 把带顶点形变的卡通网格接到 ID 墨线上（墨线贴着形变走）→ `src/shotA.js`、`src/shotC.js`

**look · 后期**（`engine/look/index.js` 的 `createLook` 按固定顺序串起来；单独模块一般不直接用）
- `engine/look/index.js` → 主场景 → ID 图墨线 → 雾 → bloom → 调色 → Kuwahara → 叠墨线 → 纸纹 → 暗角 → 颗粒；每帧参数 `{ t, outline, kuwahara, bloom, grade, fog, paper, vignette, grain, debug }`，写 `false` 关掉一道 → `src/look.js`（《北冥》默认参数）、模版 `main.js`
- `ids.js` / `ink.js` / `compose.js` → 物体 ID 图、边缘检测 + 手绘笔画（`boilFps` 换拍沸腾）、墨色合成；哪些物体描边由 `userData.outline` 决定
- `fog.js` / `bloom.js` / `grade.js` / `kuwahara.js` / `paper.js` → 空气透视雾、mip 链光晕、调色（lift/gamma/gain、高光肩）、8 扇区 Kuwahara 笔触（远近不同半径）、外部或程序化纸纹
- `debug.js` → 看中间缓冲：`debug: 'id' | 'depth' | 'edge' | 'line' | 'bloom' | 'paper' | 'kuwahara' | 'scene'`
- `params.js` / `pass.js` / `glsl.js` → 参数合并与颜色换算、全屏 pass 底座、PCG 哈希值噪声

**paint · Canvas 2D 绘画**（人物、手绘层）
- `engine/paint/ink.js` + `path.js` + `curve.js` → 路径小语言、按拍换形的手绘墨线、弧长取点 → `src/girl.js`、`src/hud.js`
- `engine/paint/strand.js` → 发簇 / 草叶随风摆的中心线与轮廓 → `src/girl.js`
- `engine/paint/light.js` → 剪影的硬边轮廓光、内渗光、光包裹、玻璃反光 → `src/girl.js`
- `engine/paint/wash.js` / `canvas.js` / `affine.js` → 水彩斑驳纸纹、离屏层复用与合成、2D 仿射 → `src/girl.js`

**overlay · 显示层**（画在最上层画布，不过后期，永远锐利）
- `engine/overlay/text.js` → 字体加载、量字、带暗晕与辉光的字、卡片、文字方框记录（给 `window.TEXTS`）→ `src/hud.js`、模版 `main.js`
- `engine/overlay/widgets.js` → 圆角框、取景括号、断开圆弧、屏幕固定元素随头部微晃 → `src/hud.js`
- `engine/overlay/brush.js` → 毛笔逐笔写字（字形当墨、手标骨架、飞白）→ `src/hud.js` 的片名

**audio · 声音**（Python，48 kHz，确定性；`sys.path` 放仓库根后 `from engine.audio import ...`）
- `dsp.py` → 包络、噪声、滤波、摆位、卷积混响、压缩 / 真峰值限制 → 模版 `sound.py`、`audio/mix.py`
- `synth.py` → 共振峰发声器、玻璃音、气泡、泊松事件流 → 模版 `sound.py`
- `ambience.py` → 城市低鸣、水面、风、发丝沙沙 → 模版 `sound.py`、`audio/mix.py`
- `sampler.py` + `orchestra.py` → 多采样乐器（CC0 库不随仓库分发，`BEIMING_SAMPLES` 指路径）与编配 → `audio/score.py`
- `mixing.py` / `meter.py` / `scope.py` → 摆放、让路、定电平、响度收口；BS.1770 响度与真峰值测量；频谱 / 波形自检图 → `audio/mix.py`、`audio/check.py`

**render · 出片**
- `engine/render/still.mjs` → 静帧：`node engine/render/still.mjs <作品目录> <t> ... [--range a:b:step] [--size WxH] [--query k=v] [--out 目录]`
- `engine/render/video.mjs` → 逐帧视频：`node engine/render/video.mjs <作品目录> [--size WxH] [--fps 24] [--workers 4] [--out 文件]`（分段并行，x264 crf 14，无音轨）
- `engine/render/mux.sh` → 音画封装：两遍 loudnorm 线性归一到 −14 LUFS / −1.2 dBTP，音频短了补静音
- `engine/render/page.mjs` → 本地静态服务器（根目录 = 仓库根）+ 无头 Chrome，等 `window.READY`；`BEIMING_ANGLE=metal|vulkan|gl|default`

**production · 项目记录**
- `engine/production/project.js` → ProjectSpec / RenderResult 字段校验（T01）；**渲染器目前不读它**，测试见 `tests/production/project.test.mjs`

**未实现**（不要报告成已有）：FrameState 统一状态与跨后端适配器、风格规范化版本、完整人物表演（见 `docs/TRACKS.md` 的 T03–T08）；把本路线的画面放到原生运行时上执行；渲染器读取 `film.json` 或 ProjectSpec（模版是 `main.js` 自己 `fetch('./film.json')`，`build.sh` 自己读 fps / size）。

## 契约

**页面约定**（`engine/render/page.mjs`；用 `createFilm().run()` 时自动兑现）
- `window.DUR`：时长（秒）。`window.render(t)`：把画面画到时刻 `t`，必须确定性。`window.READY = true`：贴图、字体、着色器全部就绪。可选 `window.TEXTS(t)`：返回该时刻画面上的文字方框 `[{ id, text, x0, y0, x1, y1 }]`。
- 作品目录必须在仓库内且有 `index.html`；静态服务器根是仓库根，所以 `/node_modules/...` 与 `../../engine/...` 都能取到。

**镜头对象**（`createFilm().run({ shots: [{ at: 开始秒, shot }] })`）
- `shot = { scene, camera, update(t, f), look(t) → 后期参数 }`；`f = frameOf(t, fps)` 是整数帧号，一拍二 / 一拍三从它量化。
- 镜头按 `designHeight` 的设计稿用像素坐标摆（模版里 = `film.json` 的高）；`--size` 更大时渲染器、后期、显示层用实际像素，显示层坐标乘 `K = 实际高 / 设计高`。
- `draw(ctx, t, shot)` 每帧在清空的显示层上画；`texts(t)` 给 `window.TEXTS`；`warm` 列出预热时刻（编译着色器、生成阴影贴图）。

**确定性规则**
- 不用 `Date.now()`、`performance.now()`、`Math.random()`；随机一律 `mulberry(种子)` 或 `hashi(帧号)`，按固定顺序取数。
- 有状态的东西（积分路径、模拟）要么在构建时预计算成 `t` 的函数（`integratePath`），要么验证跳帧与乱序一致后再分段并行。
- 全局时间、镜头局部时间、动作相位分开写；量化从整数帧号出发，不用 `t*8` 这类浮点乘法。

**film.json**（模版与 `films/*` 的最小记录，`npm run check:repo` 校验）
- `{ "route": "a", "title": "...", "dur": 秒 > 0, "fps": 正整数, "size": [偶数宽, 偶数高] }`；可以加别的键，这五个必须有且合法。
- 它不是 `engine/production/project.js` 的 ProjectSpec；需要完整项目记录时按 `docs/routes/contracts.md` 另写。

**着色与描边约定**
- 卡通材质的主光 = 场景里第一盏 `castShadow` 的平行光，只取方向和投影；颜色全按材质参数给定（`createFilm` 已设 `NoToneMapping`）。
- 只有 `userData.outline === true` 的网格描边（`toonKind().bind` 会设）；底板面片不描边；材质有顶点形变时用 `engine/stage/outline.js` 的 `wireOutlines` 把同样形变交给 ID 图。
- 后期参数的像素量按 `refHeight`（模版 1080）标定，换分辨率画面一致。

**产物**
- 一律写 `films/<名字>/out/` 或仓库根 `out/`（都被 `.gitignore` 忽略），不提交成片、帧序列、wav。

## 验收

按顺序做，每一步留下命令和结果：

1. **仓库规范**：`npm run check:repo`，本作品相关项全绿。
2. **关键帧**：`node engine/render/still.mjs films/<名字> 0 <中段> <结尾> --out films/<名字>/out/stills`，逐张打开看：不是黑屏 / 白屏 / 纯色；墨线、分档、底板、片名都在；控制台无 `[页面错误]`。
3. **出片**：`sh films/<名字>/build.sh`，核对末尾 ffprobe：视频帧数 = `round(dur × fps)`、宽高 = `film.json` 的 `size`、`r_frame_rate` = fps、有一条 48000 Hz 双声道音轨、时长 = dur；mux 打印的响度约 −14 LUFS。
4. **确定性**（改了时间相关代码时必做）：同一个 `t` 在两次独立运行、不同渲染顺序下截图逐字节一致，例如 `node engine/render/still.mjs films/<名字> 1.5 --out /tmp/a` 与 `node engine/render/still.mjs films/<名字> 2.9 0.4 1.5 --out /tmp/b` 后比较两张 `s_1.5.jpg` 的 md5。
5. **分辨率**（要出 4K 时）：`--size 3840x2080` 渲同一帧，缩到同尺寸和 1080 版对比构图一致。
6. **人工观看**：完整看一遍成片，动作、节奏、声画对位由人判断。

状态分三件事记录，互不替代：**已输出**（文件在）、**技术检查通过**（上面 1–5）、**人工认可**（用户看过并认可）。

已知的正常差异：`video.mjs` 分段数不同（`--workers 1` 与 `4`）时，截图逐帧相同，但 x264 编码后的解码帧会有细小差异（本模版实测平均 PSNR 约 49 dB），这是编码器码率控制造成的，不是渲染不确定。

## 边界与常见坑

- **模版不能原地打开**：`routes/a-webgl/template/` 里的相对路径按 `films/<名字>/` 的深度写，在模版目录直接渲染会找不到 `../../engine/`。先 `new-film` 再渲染。
- **依赖装在仓库根**：importmap 指向 `/node_modules/three/...`；没跑 `npm run setup`（或没有 `node_modules`）页面会报缺少必需文件。three 固定 r170，`engine/shade/patch.js` 的锚点在其他版本会直接报错。
- **中文字体**：`fonts/` 里的中文字体是只含特定字的子集（见 `fonts/fetch_fonts.sh`），模版片名用 Barlow + 系统字体回退。不同机器的系统字体不同会让字形不同；交付前按 `fetch_fonts.sh` 的办法给自己的文字抓一份子集，用 `loadFonts` 载入。
- **Python 环境**：系统自带 `python3` 可能没有 numpy；装 `requirements.txt` 或用 `PYTHON=` 指定环境。`sampler.py` 需要的 CC0 采样库不随仓库分发。
- **GPU 后端**：macOS 默认 Metal；Windows / Linux 的 RTX 机器设 `BEIMING_ANGLE=vulkan`，否则可能落到核显或软件渲染（`page.mjs` 会打印提示）。本路线的 GPU 数据只代表 WebGL 执行，不能当原生路线的成绩。
- **渲染器不读 film.json**：`still.mjs` / `video.mjs` 默认 1920×1040、24 fps；改了 `film.json` 的 `fps` 或 `size`，直接调用时要带 `--fps` / `--size`（`build.sh` 已自动带上）。
- **底板摆法**：底板在**起始机位**下按屏幕像素摆（`placeOnScreen`），之后相机怎么动，视差由透视产生；相机要平移时把底板摆得比画面宽（模版宽 1.4–1.5 倍）。
- **显示层不过后期**：片名、字幕画在 `draw` 里，不会被 Kuwahara、bloom、纸纹处理；要被风格化的文字得做成场景里的面片。
- **颗粒**：页面内 `grain` 与 `mux.sh` 的第 5 个参数二选一，别叠两层。
- **不是照片滤镜**：给照片加 Kuwahara + 墨线不等于三维建模；造型、着色、后期要分别验证（`debug` 视图逐层看）。
- **新作品不改 `src/`**：《北冥》原片与关键帧是基准；实验放 `films/` 或 `lab/`。
- **路线外的事**：要原生 GPU / 骨骼角色 / 不要北冥美术规则 → B；北冥画风 + 原生能力的对接方案在 `docs/raea/integration.md`，属设计稿，未实现。

## 参考作品

- **模版本身**：`routes/a-webgl/template/`——一个镜头用到造型、着色、底板、后期、显示层、声音各一处，是最小完整片。
- **《北冥》10 秒样片**：`src/`。入口 `src/main.js`（镜头表、显示层），镜头 `src/shotA.js`（黄浦江大远景：十几层底板面片的透视视差、远景鲲一拍三、渡船、鸽群一拍二）/ `src/shotB.js`（人物逆光近景：Canvas 2D 人物 + 抠像面片）/ `src/shotC.js`（第一视角仰望：穹顶面片、近景鲲游过头顶、眼镜显示层），后期配方 `src/look.js`，色板与材质预设 `src/toon.js`，声音 `audio/`。一键重建：`npm run build`；只出静帧：`npm run stills`。参考帧在 `media/shot_*.jpg`。
- **造型与材质变体**：`src/kun_refine.js`、`src/kun_qinglv.js`（青绿仙山，用了 `rock.js`）、`src/kun_xuan.js`、`src/kun_bronze.js`、`src/kun_peng.js` 与对应的 `src/toon_*.js`。
- **模块自测页**：`lab/`，经根目录 `index.html?test=<名字>` 加载，例如 `node engine/render/still.mjs . 1.0 --query test=look --out out/lab`。可用名字：`look`（后期各道开关与调试视图）、`kun`、`kun_refine`、`kun_qinglv`、`kun_qinglv_look`、`kun_xuan`、`kun_bronze`、`kun_peng`、`girl`、`hud`。
- **深入阅读**：[北冥风格手册](../../docs/routes/beiming-style.md)（真实参数、变量实验、画风扩展步骤）、[渲染与 4K](../../docs/渲染与4K.md)、[技术分档](../../docs/TRACKS.md)。
