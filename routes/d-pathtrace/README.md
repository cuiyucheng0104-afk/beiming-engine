# D · 北冥光追 · 物理路径追踪

终渲默认自动交付模式：`npm run film -- build films/<名字> --final` 无需 look / animatic 用户原话，机器 QA 照常执行。需要逐步人工审阅时加 `--delivery-mode review`，沿用 look → animatic → final 记录；只有真实成片认可才可写 accepted。

> 路线手册。第一次进仓库、要用这条路线做片，读完这一份就能开工；四条路线怎么选见 [routes/README.md](../README.md)。
> 导演方法、画面规范与六章工艺在 [routes/directing/](../directing/README.md)，这里只写 D 路线怎么落地，不重复它们。

## 这条路线是什么

**北冥光追 · 物理路径追踪**（`d-pathtrace`）是本仓库基于硬件光追与 Compute BVH 回退的**确定性物理三维出片路线**：多次弹射全局光照（GI）、面光源软阴影、各向异性拉丝金属与清漆镜面、体积雾与粒子火球、三维微晶 HUD 同场解算，由热驻留进程直出无损 8-bit BT.709 PNG 序列交 `engine/render/lib/mux.mjs` 一次封装成片，不经无头浏览器二次翻拍。

- **开源与商业可用**：底层调用第三方开源运行时 `ThreeRT`（`meshy-dev/ThreeRT`，**MIT 许可**；可选启用 Intel Open Image Denoise `Apache-2.0` 降噪），不带 FSL 竞争性使用限制，可合法用于自制影片与商业交付（决定 D13）。运行时可执行文件放仓库外缓存或由 `BEIMING_PT_BIN` 指向，经 `engine/pathtrace/runtime.lock.json` 锁定版本与 `sha256`，不把二进制或 Rust / WGSL 源码提交进 git（决定 D10）。
- **纯帧号确定性**：场景入口 `scene.ts` 经 `definePathtraceFilm` 按整数帧 `frame` 纯函数求值（`evaluation: "absolute"`），单帧抽检、分段续跑、多机分片逐像素一致。
- **适合**：硬表面工业产品与精密机械、物理金属与黑曜石镜面光学、建筑空间光影、体积烟火流体、高能科幻奇观短片。延续《北冥》三渲二墨线纸纹画风选 [A · WebGL 三渲二](../a-webgl/README.md)；骨骼角色与多媒介页面舞台编排选 [B · 北冥原生 · BNE](../b-native/README.md)；平面排版与 86 种代码画法选 [C · 86 式](../c-style/README.md)。

## 最快上手

在仓库根目录执行（首次装环境先跑一次 `npm ci && npm run setup`）：

```bash
# macOS / Linux（未设 BEIMING_PT_BIN 时自动查找 ~/.cache/beiming/pathtrace/<版本>/bin/threert-render）
export BEIMING_PT_BIN="$HOME/.cache/beiming/pathtrace/0.1.1-beiming.1/bin/threert-render"
npm run env:doctor -- --route d
```

```powershell
# Windows PowerShell
$env:BEIMING_PT_BIN = "$HOME\.cache\beiming\pathtrace\0.1.1-beiming.1\bin\threert-render.exe"
npm run env:doctor -- --route d
```

新建作品并按三道创作闸门（决定 D08：look → animatic → final）推进：

```bash
npm run new -- d my-film --title 我的短片           # 从 routes/d-pathtrace/template 生成 films/my-film/（film.json v2）
npm run film -- check films/my-film                # 只读检查：film.json、pathtrace 字段、镜头表、事件表与闸门
npm run film -- stills films/my-film               # 风格关键帧 + 联系表 → 给用户定画风（look 闸）
npm run film -- animatic films/my-film             # 半分辨率 4 SPP 动态预演（带混音）→ 给用户定节奏（animatic 闸）
npm run film -- build films/my-film                # 工作版整片：打包 → 探测 → 混音 → 光追逐帧 → 封装 → 机器 QA
npm run film -- build films/my-film --final        # 终渲（须先有 look 与 animatic 的用户原话批准记录，否则 exit 4）
npm run film -- status films/my-film               # 查看闸门、最近运行与下一步
```

每道闸都停下来请用户审看；用户原话用 `npm run film -- review approve <闸> films/my-film --quote "<用户原话>" --source "<出处>" --reviewer "<审阅人>"` 记录。**agent 不得自己批准闸门**，代理自查结论用 `review note` 记为 `comment`。「已交付」「用户已认可」只在 `status` 显示 `accepted` 时写。远端大算力显卡终渲直接复用 `node tools/remote/cli.mjs render <机器名> films/my-film`，不写私有传输脚本。

## 一部作品的目录

`npm run new -- d <名字>` 从 `routes/d-pathtrace/template/` 生成：

```text
films/<名字>/
  film.json       唯一时间与规格源（v2）：output、整数帧 shots[] 与 events[]、pathtrace 段、audio、aigc、credits、gates
  scene.ts        三维光追场景：import ../../engine/pathtrace/index.js 与 @threert/scene，经 definePathtraceFilm 纯帧号驱动相机、灯光、材质与三维铭牌
  mix.py          程序化立体声音轨：读 film.json 的帧率、总帧数与事件帧，输出 48 kHz PCM_24 WAV（−14 LUFS、真峰值 ≤ −1.5 dBTP）并自检起音
  TREATMENT.md    导演阐述：规格头、三候选结构、弧线、视觉系统、镜头表、节拍表、Cue map、声音设计与自检记录
  README.md       本片改哪里、怎么出片
  assets/         本片自有贴图或离线生成的微晶 HUD 纹理（可选，5 MiB 以内）
  review/         三道闸门的用户审阅记录（film review 生成，随作品提交）
  out/<run-id>/   出片产物（master.mp4、web.mp4、poster.jpg、contact.jpg、player.html、run.json、qa/report.json），永不提交
```

运行目录 `out/<run-id>/` 内：`work/scene.bundle.js` 是 `esbuild` 打包出的单文件场景（供 `threert-render serve` 的 QuickJS 环境热加载），`work/texts.json` 是探测阶段导出的逐帧三维文字像素包围盒；帧序列按场景哈希缓存在 `out/cache/pt-frames/`，只改某镜参数或用 `npm run film -- render films/<名> --shot S02` 时，未改动帧直接硬链接复用。

## 能力清单

| 领域 | 模块与原语 | 能做什么 |
|---|---|---|
| 场景驱动与确定性 | `engine/pathtrace/index.js`（`definePathtraceFilm`、`frameSeed`） | 统一封装 QuickJS `threert-render serve` 帧状态与 Node 探测模式（纯 ESM `.js + .d.ts`，Node 22 原生直跑）；`frameSeed(seed, frame)` 提供跨帧无状态的确定性随机源 |
| 视锥摆位与像素投影 | `engine/pathtrace/camera.js`（`placeInCameraFrustum`、`projectBoxToPixels`） | 将近裁面微晶铭牌按屏幕像素框 `[x, y, w, h]` 精确锁定在相机视锥内；将世界包围盒投影为屏幕像素框供安全区与对比度 QA 核对 |
| 三维纳米晶圆 HUD | `engine/pathtrace/hud.js`（`createWaferHudMaterial`） | 自动注入 `o.base = vec3<f32>(0.0); o.specular = 0.0;` WGSL 材质并约束厚度 `z ≤ 0.0015`，强聚光灯扫过前景时暗底零泛白、广角零百叶窗拉伸 |
| 实心倒角与基础几何 | `@threert/scene`（`BoxGeometry`、`CylinderGeometry`、`PlaneGeometry`、`RingGeometry`、`OctahedronGeometry`、`BufferGeometry`） | 硬表面工业体块、多边形内缩斜切倒角（bevel crown + armor）、精密刻度环与承力构件 |
| 物理金属与程序化 WGSL | `MeshStandardMaterial`、`MeshPhysicalMaterial`、`MaterialFunction` | 各向异性拉丝钨钢、清漆镜面黑曜石、自发光熔核；用 WGSL 字符串按世界坐标 `i.wp` 或 `i.uv` 实时计算六角晶格、CNC 刀纹与解析天幕 |
| 物理光源与环境天幕 | `RectAreaLight`、`SpotLight`、`DirectionalLight`、`PointLight`、`SkyGradient` | 影棚柔光箱面光源软阴影、窄束高光灯刃（Light-Wand）、双色追光灯阵、零散射噪点的解析天幕环境光 |
| 体积与粒子奇观 | `FogVolume`、`SparkBurst`、`Fireball`、`WaterBody`、`Debris` | 局部体积雾、锻造飞溅火花束、热核火球、物理折射水面与刚体碎屑（均由帧号确定性驱动） |
| 声音合成与拍点核对 | `engine/audio/`（`dsp`、`mixing`、`meter`、`foley`、`director`、`cuecheck`） | 48 kHz 程序化金属瞬态、低频腔体共鸣、感知响度归一（−14 LUFS）与事件结果帧起音自检 |

**未实现**（不要报告成已有）：A 路线的屏幕空间 ID 墨线与 Kuwahara 纸纹后期尚未合入 `threert-render` 的 16-bit 分层通道（`--channels` 在规划中，见 [工程规格书](../../docs/routes/pathtrace.md)）；复杂蒙皮角色骨骼 IK 表演请选 B 路线。

## 契约

- **`film.json` v2 与 `pathtrace` 段**：`route` 固定为 `"d"`，`backend` 为 `"pathtrace"`，`entry` 默认为 `"scene.ts"`。顶层 `pathtrace` 段只允许声明渲染采样与降噪参数，**严禁写任何带 `frame / sec / in / out / dur` 词根的时间字段**（作品校验器 `isTimeLikeField` 会判为无消费者的时间字段并退 4）：
  - `preset`：`"cinematic"`（正式）或 `"preview"`（快速预览）
  - `spp`：正整数，默认全局每像素采样数（如 `24` 或 `32`）
  - `animaticSpp`：正整数，动态预演采样数（默认 `4`，半分辨率出片）
  - `denoise`：`"auto"` | `"oidn"` | `"wavelet"` | `"none"`（`"auto"` 在运行时链接了 OIDN 时自动启用 AI 降噪，否则回退内置引导小波降噪）
  - `seed`：整数随机种子（模版默认 `2026`）
  - `shotSpp`：`{ "<镜头ID>": <正整数> }`，**只按镜头 ID 映射高采样镜头**（如 `{ "S02": 48 }`）；镜头帧区间唯一取自 `shots[]`，执行 `node engine/production/film.js retime` 改切点时高采样区间自动跟随镜头移动
  - `overlay`：`"none"`（默认纯三维直出）或 `"page"`（封装前叠合透明页面字幕层）
- **纯帧号场景契约（`definePathtraceFilm`）**：`scene.ts` 从 `../../engine/pathtrace/index.js` 导入并默认导出 `definePathtraceFilm(({ width, height, fps, film }) => ({ scene, camera, renderFrame(frame, ctx), textsAt?(frame, ctx) }))`。
  - `renderFrame(frame, ctx)` 接收整数帧 `frame` 与 `{ t, shot, localFrame, localT, hideTexts }`，必须把所有动态节点与光源在当前帧的变换、强度、材质参数完整写出，不依赖上一帧残留状态。
  - 凡是在 `renderFrame` 中修改位置、旋转、缩放或目标点的 `Mesh`、`Group`、`RectAreaLight`、`SpotLight`，必须在初始化时设 `.movable = true`，否则底层静态 BVH 不会逐帧更新。
- **三维文字与真实对比度门禁**：画面内有文字或铭牌时，`textsAt(frame, ctx)` 返回 `[{ id, text, box: [x, y, w, h], alpha, font }]`（屏幕像素坐标，落在 90% 图文安全区内，连续可读时长满足档位 `minHoldSec`）。当 `ctx.hideTexts === true` 时，`renderFrame` 必须隐藏该文字几何体：出片与 QA 据此渲染同帧去字对照图，实测世界内三维文字与光追背景的 WCAG 相对亮度对比度（硬门 `≥ 3:1`）。
- **声音契约**：`mix.py` 从 `film.json` 读取 `output.fps`、`output.frameCount` 与 `events[]`，核对统一出片注入的 `BEIMING_FPS`、`BEIMING_FRAMES`，写出路径优先取 `BEIMING_AUDIO_OUT`（独立运行时写 `films/<名>/out/mix.wav`）。事件帧是画面已发生变化的结果帧，声音同帧或晚 1 帧内起音。

## 画面工艺

从实战标杆沉淀的三条光追硬工艺，改模版或做新片时务必保持：

1. **暗底三维晶圆零冲灰（`o.base = 0; o.specular = 0;`）**：标准 PBR 电介质表面默认带约 `4%` 菲涅尔镜面反射（`F0 ≈ 0.04`）。当前景掠过数千坎德拉的近距聚光灯或柔光箱时，普通暗色贴图面片会被洗成一片灰白并投下硬影。所有深色 HUD 晶片与解析背景板统一注入 `o.base = vec3<f32>(0.0); o.specular = 0.0;`，只由 `o.emissive` 输出纯净发光字形与刻度。
2. **近裁面附着件厚度锁 `z ≤ 1.5 mm`**：用 `placeInCameraFrustum` 挂在镜头前的边框、刻度条或铭牌，局部 Z 厚度必须 `≤ 0.0015` 米（`1.5 mm`）。超过 `5 mm` 的薄盒在广角视锥边缘会被透视拉出明显的侧壁百叶窗伪影，遮挡主视觉。
3. **解析天幕优先，按镜头预算 SPP**：大面积远景渐变、日冕环与星盘背景优先用 `SkyGradient` 或纯解析 `MaterialFunction`（0 散射噪点，`24–32 SPP` 即丝滑干净）；随机步进的 `FogVolume` 只放在需要体积光束的局部空间，并通过 `pathtrace.shotSpp` 单独给重散射或终局微距亮相镜头升采样（如 `48–96 SPP`），把整片渲染耗时压在数十秒级。

## 验收

1. **环境与运行时核验**：`npm run env:doctor -- --route d` 与 `node engine/pathtrace/runtime.mjs status` 退出码 `0`，锁文件哈希一致。
2. **统一出片与机器 QA 硬门**：`npm run film -- build films/<名>` 退出码 `0`，运行目录生成 `master.mp4`、`web.mp4`、`poster.jpg`、`contact.jpg`、`run.json` 与 `qa/report.json`（交付规格、BT.709 `tv` 四项色彩标签、−14 LUFS 响度与真峰值、黑场/静帧/闪帧/切点、三维文字安全区与对比度、声画同步全部通过）。
3. **确定性与接缝一致性**：同一提交连续两次 `build --no-cache` 解码帧哈希（`framemd5`）逐帧一致；`npm run film -- render films/<名> --shot S02` 局部重渲与全量渲染在切点前后逐像素一致。
4. **仓库护栏与合规扫描**：`npm run check:repo -- --only route-d` 与 `npm run comp:scan` 退出码 `0`。
5. **人工审片（D08）**：机器 QA 通过只代表「代理检查通过」；全速带声观看整片并按 [RUBRIC.md](../../docs/quality/RUBRIC.md) 记下用户原话批准 `final` 闸后，才可写「已交付 / 用户已认可」。

## 边界与常见坑

- **不把二进制或着色器源码文件入库**：`threert-render` 可执行文件、`OIDN` 动态库以及 `.rs` / `.wesl` / `.wgsl` / `Cargo.toml` 一律不进 git（`route-d.runtime-and-template` 与 `comp.fsl-boundary` 双重拦截）；作品自定义材质只以 WGSL 字符串写在自有 `.ts` / `.js` 文件内。
- **忘记设 `.movable = true` 导致画面静止**：静态网格在首帧建好加速结构后默认固定；逐帧运动的物体、相机附着件与穿梭灯光必须在 `setup` 阶段显式标 `.movable = true`。
- **`shotSpp` 写了帧号报错**：`shotSpp` 的键只能写 `shots[]` 里存在的镜头 ID（如 `"S02": 48`），写 `"36-72"` 或加 `startFrame` 会被校验器按非法时间字段直接拒绝（exit 4）。
- **禁止跨帧累加可变状态与 `Math.random()`**：`renderFrame` 内用 `let angle += 0.02` 或 `Math.random()` 会让 `stills` 抽帧、分段续跑与 `animatic` 画面彻底错位；随机抖动与粒子相位一律用 `frameSeed(film.pathtrace.seed, frame)` 或纯解析函数。
- **降噪器如实记录**：`runtime.lock.json` 的 `oidn` 布尔值必须如实反映二进制是否真实链接了 Open Image Denoise；`denoise: "auto"` 在无 OIDN 环境下自动退回内置引导降噪，不伪造运行记录。
- **命名与 AI 标识（D04、D11、D13）**：对外只写「北冥光追 · 物理路径追踪」，产品与路线名不带 `RTX`，不用 `ThreeRT` 命名目录、文件、脚本或环境变量；含 AI 生成贴图时在 `film.json` 如实填 `aigc.contains: true`。

## 参考作品

- **3 秒起步模版** [`routes/d-pathtrace/template/`](template/)：两镜头（`S01 [0,36)` 拉丝钨钢微距掠射扫光 → `S02 [36,72)` 镜面黑曜石底座定格揭示 + 左上安全区零冲灰三维微晶铭牌），配确定性合成金属声轨与起音自检，新建后可直接跑通 `stills → animatic → build`。
- **工程深入手册**：[D 路线光追引擎工程手册](../../docs/routes/pathtrace.md)（架构、打包与探测协议、帧缓存与远程 5090 协同）。
- **导演与声音工艺**：[导演方法](../directing/README.md)、[音效设计与拟音工艺](../directing/craft/sound.md)、[机器 QA 门](../../docs/quality/QA-GATE.md)。
