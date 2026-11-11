# A · 北冥风格路线 · WebGL 三渲二

> 路线手册。第一次进仓库、要用这条路线做片，读完这一份就能开工；三条路线怎么选见 [routes/README.md](../README.md)。
> 导演方法、画面规范与五章工艺在 [routes/directing/](../directing/README.md)，这里只写 A 路线怎么落地，不重复它们。

## 这条路线是什么

用代码做**确定性的三渲二短片**：三维程序化造型 + 三档卡通着色 + 屏幕空间手绘墨线 + Kuwahara 颜料笔触 + 二维底板的透视视差 + 不过后期的显示层（片名、字幕）。画面在无头 Chrome 的 WebGL（Three.js r170）与 Canvas 2D 里画，逐帧截图交给 FFmpeg 编码；声音用 Python 程序化合成。

- 每一帧都是整数帧号 `f` 的纯函数：任意一帧能单独重渲，分段并行不改变画面。
- 画风由造型（`engine/form`）、着色（`engine/shade`）、后期（`engine/look`）共同决定。画风的数值登记在**画风注册表** `engine/style/`（`beiming-original@v1` 就是《北冥》样片的画风），镜头按 `lookPreset` 取用，不在镜头里散写。
- 适合：延续《北冥》画风；品牌片、概念片；要精确控制色阶、阴影、墨线、纸纹、二维与三维比例。
- 不适合：要原生 GPU、骨骼角色大量表演、不要北冥美术规则的通用场景 → [B · 北冥原生 · BNE](../b-native/README.md)；只想借一种成熟的代码画法 → 先查 [C · 86 式](../c-style/README.md)，再回来落地（落到 A 时先关掉北冥默认后期，见 [craft/README §6](../directing/craft/README.md)）。

## 最快上手

第一次在这台机器上做（各一次，在仓库根目录）：

```sh
npm ci && npm run setup          # Node 依赖、锁定版本的无头浏览器、Python 环境 .venv（声音与字体子集化都用它）
npm run env:doctor -- --route a  # 逐项核对；缺什么按它给的命令补
node tools/fonts/fetch.mjs       # 按 fonts/fonts.lock.json 取完整 OFL 字体（约 24 MB，进 .cache/fonts/，不进 git），逐字节核对 sha256
```

做一部片（`npm run film -- <子命令> --help` 看全部参数）：

```sh
npm run new -- a my-film --title 晨渡                     # 模版 → films/my-film/（作品名用小写 ASCII，片名用 --title）
node tools/fonts/subset.mjs films/my-film                 # 按 film.json 的 texts 生成本片字体子集；缺字直接失败
npm run film -- check films/my-film                       # 只读检查：作品描述、页面契约、档位、镜头表、闸门
npm run film -- stills films/my-film                      # 风格关键帧 + 联系表 → 给用户看（look 闸）
npm run film -- animatic films/my-film                    # 半分辨率动态预演 → 给用户看（animatic 闸）
npm run film -- build films/my-film --final               # 终渲：声音 → 逐帧 → 封装 → 网页版 → 机器 QA，产物在 films/my-film/out/<运行号>/
npm run film -- status films/my-film                      # 任何时候：闸门、最近一次运行、下一步
```

模版本身就是一部 8 秒、两个镜头、能直接出片的完整作品（见「参考作品」第一行）。**改片之前先跑一遍原样出片**（不加 `--final` 的工作版不查闸门），确认环境是好的。

**从定调到交付：三道闸**（决定 D08：look → animatic → final）。每道闸都停下来请用户看；用户的原话用 `npm run film -- review approve <闸> films/<名> --quote "<原话>" --source "<出处>" --reviewer "<审阅人>"` 记下。**agent 不得自己批准、不得替用户写原话**；用户说「不用看了」就按原话记豁免（`review waive`）。「已交付 / 用户已认可」只能由 final 闸认可后的 run.json（accepted）生成。

| # | 做什么 | 产物 | 依据 |
|---|---|---|---|
| 1 | 接需求：片长（帧）、画幅、交付档位、路线理由、能力边界核对 | 阐述 §0–§2 | [DIRECTING 步骤 1](../directing/DIRECTING.md)、§2.1 能力边界 |
| 2 | 写阐述（小样填必填表即可） | `films/<名>/TREATMENT.md` | [templates/TREATMENT.md](../directing/templates/TREATMENT.md) |
| 3 | **定调**：选已登记的画风，或按定调流程做新画风；出 3–5 张钥匙帧 + 色彩脚本条 + 灰度与剪影检查 | `film stills`、`?sil=1` 剪影帧 | [LOOKDEV.md](LOOKDEV.md)、[VISUAL-DESIGN §1–§3](../directing/VISUAL-DESIGN.md) |
| ⛔ | **look 闸**：用户认可钥匙帧之前，不许把片子做长 | `films/<名>/review/look-*.json` | D08 |
| 4 | 镜头表与事件表写进 `film.json`（整数帧；切点、事件、字幕同源） | `film.json` | [animation §5](../directing/craft/animation.md)、附录 C6 |
| 5 | 动态预演：同一条时间轴、半分辨率、带声音事件 | `film animatic` | [DIRECTING 步骤 7.5](../directing/DIRECTING.md) |
| ⛔ | **animatic 闸**：用户确认节奏与镜头 | `review/animatic-*.json` 或豁免 | D08 |
| 6 | 制作：造型、着色、底板、后期、片名、声音（逐层对照「能力清单」） | 镜头模块、`sound.py` | 五章工艺 |
| 7 | 终渲 + 机器 QA（规格、BT.709 tv、响度、黑场闪帧、切点、读字与缺字、对比度、声画对位、露边） | `out/<运行号>/`、`qa/report.json` | 「验收」 |
| ⛔ | **final 闸**：用户全速带声看完整片 | `review/final-*.json` | D08 |

## 一部作品的目录

`npm run new -- a <名字>` 从 `routes/a-webgl/template/` 复制出：

```
films/<名字>/
  film.json      作品描述 v2：唯一的时间与规格来源（下面「契约」）；页面、声音、QA 都读它
  index.html     页面入口：importmap 把 three 指到仓库根的 /node_modules，再加载 main.js
  main.js        入口：读 film.json → 字体子集 → 画风注册表 → 按镜头表加载镜头模块 → 显示层（片名、副标题）
  world.js       各镜头共用的世界：色指定、材质（含皴与层理）、三维主体、水面、太阳与罩色、手绘层、构图反算机位
  shots/s1.js …  一个镜头一个模块：build({ shot, fps, DW, DH, K, preset, mixLook, sun, eventFrame }) → { scene, camera, update, look }
  title.js       片名题写（墨色洇开，任何字都能用，不需要笔画骨架）
  sound.py       声音：读 film.json 的帧数与事件 → mix.wav，写完自检每个事件的声画对位
  fonts/         本片字体子集 + fonts.json（清单与覆盖率）+ OFL 许可全文（tools/fonts/subset.mjs 生成，提交）
  review/        闸门审阅记录（film review 写，提交）
  README.md      三五行：改哪里、怎么出片
  out/           成片与中间文件，不提交
```

片子长了照这个结构加镜头：`film.json` 加一行 `shots`，`shots/` 加一个模块。自有底板放 `films/<名字>/plates/` 并配 `plates.json`：字段见 [assets/plates/plates.schema.json](../../assets/plates/plates.schema.json)，做法见 [assets/plates/RECIPE.md](../../assets/plates/RECIPE.md)，AI 生成的底板按 [docs/rights/aigc.md](../../docs/rights/aigc.md)「来源链」逐张写「来源」（不知道的写「待补」），`node tools/plates/check.mjs films/<名字>/plates/plates.json` 准入。路径一律按 `films/<名字>/` 的深度写：引擎 `../../engine/`，three 走 importmap 的 `/node_modules/...`。

## 能力清单

先按问题查工艺章，再看对应模块开头的中文注释（接口以注释为准）。每一行在仓库里都有能跑的例子。

| 要解决的问题 | 读哪一章 | 用哪些模块 | 例子 |
|---|---|---|---|
| 三档分档、阴影换色相、边缘光、墨线、笔触、色板锁定 | [toon.md](../directing/craft/toon.md) | `engine/shade/toon.js`、`engine/look/`（`createLook` 串起全部后期） | 模版 `world.js` 的 `MAT`；`src/toon.js`、`src/look.js` |
| 底板摆位、视差、出血、纹素密度、防纸板感 | [two-five-d.md](../directing/craft/two-five-d.md) | `engine/stage/camera.js`（`placeOnScreen`）、`engine/stage/plates.js`、`engine/stage/dome.js` | 模版 `shots/s1.js`；`src/shotA.js`、`src/shotC.js` |
| 一拍 n、分层时钟、事件对拍、表演 | [animation.md](../directing/craft/animation.md) | `engine/core/clock.js`（`hold / heldTime / frameOf`）、`engine/paint/`（Canvas 人物） | 模版的渡船、墨线与片名一拍二；`src/girl.js` |
| 确定性、分辨率、色彩标签、编码、响度、质量门 | [video.md](../directing/craft/video.md) | `npm run film`（`tools/film`）、`npm run qa`（`tools/qa`）、`engine/render/` | 模版的统一出片 |
| 材质补丁、形变一致、阴影、后期渲染目标、显存 | [threejs.md](../directing/craft/threejs.md) | `engine/shade/patch.js`、`engine/stage/outline.js` | `src/kun.js` |
| 程序化造型：放样、山石、植物、器物、散布 | 各模块头注释 | `engine/form/`（`loft`、`rock`、`plants`、`props`、`scatter`） | 模版的峰、松、渡船 |
| 显示层文字与片名 | [VISUAL-DESIGN §6](../directing/VISUAL-DESIGN.md) | `engine/overlay/text.js`、`engine/overlay/brush.js`（逐笔书写，需笔画骨架）、模版 `title.js`（洇墨题写，任何字） | 《北冥》片名 `src/hud.js`；模版片名 |
| 画风登记、预设、镜头级允许调整 | [STYLE-LOCK.md](../directing/templates/STYLE-LOCK.md)、[LOOKDEV.md](LOOKDEV.md) | `engine/style/`（`loadStyle`、`resolveLook`、`mixLook`、`checkOverrides`） | 模版 `main.js` |
| 字体：锁定原始字体、按作品子集化、缺字门禁 | 本手册「契约」 | `tools/fonts/`（fetch、subset）、`engine/style/fonts.js` | 模版 `fonts/` |
| 底板登记与准入（边策略、来源链、原图尺寸、色彩空间、直线淡出、出血） | [two-five-d §2](../directing/craft/two-five-d.md)、[RECIPE.md](../../assets/plates/RECIPE.md) | `tools/plates/check.mjs`、`tools/plates/bleed.mjs`、`assets/plates/plates.json` | 13 张《北冥》底板 |
| 定调扫参（参数网格、无损 PNG、每格参数 JSON） | [LOOKDEV.md](LOOKDEV.md) | `tools/lookdev/sweep.mjs` | `lab/look.js` 的查询参数 |
| 程序化声音、声画对位、响度收口 | [DIRECTING 步骤 8](../directing/DIRECTING.md) | `engine/audio/`（dsp、synth、ambience、mixing、meter） | 模版 `sound.py`；`audio/` |

**未实现**（不要报告成已有）：通用二维骨架与人物表演库（`engine/performance/` 尚未建）；三维人物与人脸着色；点光源卡通着色；运动模糊与景深；新片名的笔画骨架工具（`tools/title`）；把本路线的画面放到原生运行时上执行。完整清单见各章「未实现」节与 [craft/README §7](../directing/craft/README.md)。

## 契约

**作品描述 film.json v2**（加固计划附录 C6；改时长、切点、事件只改这里，不改代码）
- `output { profile, width, height, fps, frameCount }`：交付档位与规格；时长 = `frameCount / fps`。默认档 `web-1080p24`（1920×1080、24 fps、H.264 yuv420p、BT.709 tv、AAC 48 kHz、−14 LUFS、真峰值 ≤ −1 dBTP）。
- `shots[] { id, in, out, module, evaluation, lookPreset, lookOverrides? }`：半开区间 `[in, out)` 首尾相接覆盖全片；`lookPreset` 写成 `<画风>@v<版本>/<预设>`，必须在 `engine/style/registry.json` 里登记；`lookOverrides` 只能改画风 `allowedOverrides` 允许的字段与范围，越界页面直接报错。
- `events[] { id, frame, shot, audio, visual }`：画面、声音、字幕读同一张事件表；事件帧是**结果帧**——画面在这一帧已经变了（太阳露头、第一笔墨落纸），声音同帧或晚一帧内起音，不能抢在画面前面（QA 的 `sync.events`）。
- `texts[] { id, text, font }`：画面文字白名单——页面只画这里登记的字，字体子集也按它生成。`fonts[] { family, source, weight?, extra? }`：字族 → `fonts/fonts.lock.json` 里锁定的原始字体；页面画字的字重从这里读。
- `style { id, version, lock, baseline }`、`audio`、`deliveries`、`assets`、`credits`、`aigc`（含 AI 生成画面时写明，D11）、`gates`、`next`（模版给 new-film 的下一步，生成的作品里不保留）。不要加没有消费者的时间字段。

**页面约定 v1**（附录 C5；模版的 `main.js` 已兑现）
- `window.DUR` = frameCount ÷ fps；`window.FPS`；`window.render(t)` 确定；`window.READY`；`window.TEXTS(t)` → `[{ id, text, box: [x, y, w, h], alpha, font }]`；另给 `window.TIMELINE`（镜头表与事件表，单位：帧）。
- 渲染器注入的 `window.__RENDER.fps` 与 film.json 不一致时页面直接报错（一拍二会变成 2、3 帧交替）；画幅比不对也报错，不偷偷拉伸。
- 禁止：渲染路径里用 `Math.random`、`Date.now`、`performance.now`；渲染时读回 GPU 画布；访问外网。随机一律 `mulberry(种子)`，按固定顺序取数。

**时间**：全局帧 `f = frameOf(t, fps)`；镜头局部帧 `f − shot.in`；一拍二、一拍三一律从整数帧量化（`hold(f, 2)`），不用 `t * 12` 这类浮点乘法。相机与底板不量化。

**字体**：只用本片子集（`tools/fonts/subset.mjs` 生成 `fonts/fonts.json` + `*.woff2`）。页面在画字前核对覆盖，缺字抛 `GlyphError`（渲染非零退出），绝不回退系统字体。改了 `texts` 就重跑子集化；`--check` 只核对不生成。

**画风**：`film.json` 的 `style { id, version }` 与每镜 `lookPreset` 都由 `engine/style/` 解析；未登记的 id、版本、预设一律报错。改色板、光照公式或后期顺序 = 新版本，按 [LOOKDEV.md](LOOKDEV.md) 走完签认再登记。

**着色与描边**：卡通材质只取第一盏 `castShadow` 平行光的方向与投影，颜色全按色板给（`NoToneMapping`）；只有 `userData.outline === true` 的网格描边（`toonKind().bind` 会设），底板、水面、辉光不描边；后期像素量按 `refHeight`（1080）标定。

**产物**：统一出片只写 `films/<名>/out/<运行号>/`（master.mp4、web.mp4、player.html、run.json、qa/report.json、contact.jpg；`out/latest` 指向最近一次跑完的运行），不提交成片、帧序列、wav。

## 验收

技术验收由机器判定，审美验收由人判定，两者互不代替（状态三分离：已输出 / 技术检查通过 / 用户认可）。

1. **统一出片与机器 QA**：`npm run film -- build films/<名>` 跑完 QA 全部硬门（规格、BT.709 tv 标注、响度、黑场与闪帧、切点、读字时长与安全区、对比度、缺字、声画对位、底板露边、AIGC 标识）；任何硬门失败退出码 4，逐项见 `out/<运行号>/qa/report.json`。单独复查：`npm run film -- qa films/<名>`。
2. **字体与画风**：`node tools/fonts/subset.mjs films/<名> --check` 退出码 0；`node tools/repo-check.mjs --only route-a` 无错误（画风、lookPreset、镜头表、字体清单、底板登记）。
3. **声画对位**：`sound.py` 自己在混音上测每个事件的起音，声音早于画面或晚 1 帧以上退出码 4；输出的 JSON 里 `errFrames` 记下实际误差。
4. **代理审片**（agent 可做，结论只能写「代理检查通过」，用 `npm run film -- review note` 记）：
   - 联系表与切点 ±3 帧：运行目录里的 `contact.jpg`；
   - 构图：`npm run film -- stills films/<名> --query guides=1`（三分线、90%/93% 安全区、文字方框）；
   - 剪影：`--query sil=1`，缩到 160 px 宽仍认得出主体；
   - 明度：`ffmpeg -i <帧>.jpg -vf "format=gray,scale=240:-2,gblur=sigma=2" <缩略图>.png`，主体仍是第一落点；
   - 六维自评（风格还原、质感、叙事清楚、镜头与节奏、构图与留白、声画与文字，各 10 分，6 分 = 方向对但粗糙，8 分 = 小修可交付），标尺见 [docs/quality/RUBRIC.md](../../docs/quality/RUBRIC.md)。
5. **确定性**（改了时间相关代码或共用材质时必做）：`node tools/baseline/determinism.mjs films/<名>`——新页面单帧、乱序、从头顺序三种渲法的像素哈希一致（默认覆盖切点前后）。
6. **人工观看**：用户或指定审片人全速带声看完整片，原话记进 final 闸。

## 边界与常见坑

- **模版不能原地打开**：`routes/a-webgl/template/` 的相对路径按 `films/<名字>/` 的深度写，先 `npm run new` 再渲染。
- **没跑子集化就渲染**：页面报「找不到字体清单」并非零退出——先 `node tools/fonts/subset.mjs films/<名>`。缓存里没有原始字体时它提示先跑 `node tools/fonts/fetch.mjs`（要代理时设 `HTTPS_PROXY` 并加 `NODE_USE_ENV_PROXY=1`；内网可把锁定清单里的文件拷进 `.cache/fonts/`，哈希对就行）；Python 缺 fontTools 时退出码 3 并给出安装命令。
- **浅色字压亮天读不出来**：晨空、日出天大多比中灰亮，白字对比度到不了 3:1（QA 硬门）。模版用墨色题款；要浅色字，就给字找暗的落点（暗水面、山体旁的暗天）或在**场景里**垫一块暗的云影——字自己的光晕、阴影不算背景，QA 照样判不过。
- **事件帧是结果帧**：画面在事件帧必须已经变了（模版的片名在 `title-in` 那一帧就有第一笔淡墨），声音同帧起音；缓起的声音（铺底、洇墨的沙沙声）量不出起音，要配一下起音清楚的声音（模版的落笔声）。
- **直接调渲染器要带画幅**：`still.mjs` / `video.mjs` 默认 1920×1040；本模版按 16:9 构图，直接调用时带 `--size 1920x1080`（或它的整数倍），否则页面报画幅比不对。统一出片按 film.json 自动带上。
- **镜头之间不留状态**：峰、松的材质两个镜头共用；逐帧要改的共享 uniform 一律经 `setToon` 每帧写全（含日出受光边 `sunUp`）。只在 S2 里改、S1 不复位，S1 的画面就取决于之前渲过哪一帧，乱序渲染对不上，验收第 5 条判不过。
- **镜头里不写后期数值**：后期参数从 `preset()` 取；要调就写 `lookOverrides`，范围由画风登记表约束。想要登记表外的效果，说明是新画风，走 LOOKDEV。
- **底板摆法**：在**起始机位**下按屏幕像素摆（`placeOnScreen`），视差交给真实透视；相机要平移时底板比画面宽（模版 1.4–1.6 倍，`node tools/plates/bleed.mjs` 算每条边要出血多少）；截断边永远在画外（`node tools/plates/check.mjs` 会标出直线淡出的边）。4K 交付先看 `check` 报告的细节密度：现有底板都是原图 ×2 放大，4K 下只有三维、墨线、纸纹与显示层是原生的。
- **在亮的晨空上加色出不来光**：太阳四周用普通混合罩一层暖色（模版 `world.js` 的 `sunGlaze`），留白的日轮才「亮」；只靠加色辉光，后期的高光肩与纸纹会把日轮压成一块灰白圆片。
- **材质里画的细线会被 Kuwahara 抹掉**：皴、层理这类画在材质里的线，笔宽要有 3–4 px 以上；要锐利的线走屏幕空间墨线（只认 `userData.outline`）。
- **构图先定屏幕位置**：用 `world.js` 的 `frameCamera` 由「地平线在哪、主体落在哪」反算偏航与俯仰，不手抄角度；切镜要换景别（模版 S1→S2 主体放大约 1.75 倍），只换角度不换景别就是跳切。
- **显示层不过后期**：片名、字幕画在最上层画布，不被笔触、泛光、纸纹处理；要被风格化的字得做成场景里的面片，并自己投影成屏幕框写进 `TEXTS`。
- **颗粒只加一次**：页面内 `grain` 与封装阶段的颗粒二选一。
- **GPU 后端**：macOS 默认 Metal；Windows / Linux 的 RTX 机器设 `BEIMING_ANGLE=vulkan`，否则可能落到核显或软件渲染（统一出片默认拒绝软件渲染，退出码 3）。
- **新作品不改 `src/`、`engine/` 已有模块**：《北冥》原片与参考帧是基准；共享能力缺了，在 `engine/` 对应层加新模块并写中文头注释，改已有模块要先出基线再逐像素比对。
- **画风认可靠钥匙帧签认，不靠风格锁**：九分钟版锁了画风、沿用了原版文件，做完 540 秒仍被否（`cases/entries/local-beiming-film-9min.md`）。look 闸之前不许把片子做长。

## 参考作品

- **模版本身** `routes/a-webgl/template/`：8 秒、两镜头，每一处都示范一条工艺（下表）。改它之前先读表，知道哪些是「工艺」、哪些只是这部片的内容。

| 示范了什么 | 在哪里 | 依据 |
|---|---|---|
| 色彩脚本：晨前（hero）→ 日出事件后按事件进度插值到 hero-sunrise；强调色只给太阳（含罩色）与船灯 | `shots/s2.js` 的 `mixLook(A, B, kAt(f))`；`world.js` 的 `PAL`、`setToon({ sunUp })`、`sunGlaze` | VISUAL-DESIGN §2；toon 判据 11 |
| 明度结构：背光的峰看到的是一影，比身后天空暗一档以上；最暗留给前景 | `world.js` 的 `PAL`、`ROCK` | VISUAL-DESIGN §3；toon 判据 5 |
| 三分构图与安全区：地平线、主体落在三分线；片名在左上留白、离主体一格以上；文字在 90% 安全区内 | `frameCamera` 的目标；`main.js` 的片名位置；`?guides=1` 可视化 | VISUAL-DESIGN §4.1、§6.3 |
| 剪影可读：主客三峰高低错落、台阶收分、峰顶的松与船夫给尺度 | `world.js` 的 `PEAKS`、`pines`、`ferryman`；`?sil=1` 检查 | VISUAL-DESIGN §3；toon 判据 1 |
| 质感：竖皴 + 横向层理画在材质里，笔宽经得住 Kuwahara；一拍二沸腾 | `world.js` 的 `CUN` | toon 判据 8 |
| 前中后景视差：前景岸石（抠像面片，150 m）、雾带、三维峰（1100 m）、远近山脊、天空（20 km） | `shots/s1.js` 的底板表（D 与 renderOrder 同序） | two-five-d §1.2–§1.6 |
| 景别与切点：S1 远 → S2 近，主体放大约 1.75 倍，主峰留在右三分线，渡船屏幕方向不变；切镜后 0.75 秒日出 | `shots/s1.js`、`shots/s2.js` 的机位；`film.json` | VISUAL-DESIGN §4.4 |
| 分层时钟：相机、雾、水流一拍一；渡船起伏、墨线与皴线沸腾、倒影扰动、片名洇开一拍二 | `hold(f, 2)` 的各处调用 | animation §2；VISUAL-DESIGN §5 |
| 水与倒影：水面倒映天空底板（地平线镜像），峰的倒影按反射几何算出，被碎波打断 | `world.js` 的 `WATER_FS` | two-five-d §4.1–§4.2 |
| 片名题写：墨色题款（与山石墨线同一种墨），淡墨先透出、再从笔画中线洇满、显完留浓淡；对比度 ≥ 4.5:1 | `title.js`；`main.js` 的 `titleP`、副标题 | VISUAL-DESIGN §6.3；DIRECTING 步骤 9 |
| 声画对位：日出那一帧钟声起音（前 6 帧近静默反衬）；第一笔墨落纸那一帧落笔声起音；声音跟着景别换近 | `sound.py`（读 `events`，写完自测两个事件的起音） | animation §5.4、§5.7；DIRECTING 步骤 8 |
| 事件驱动：太阳在事件帧刚好露出一线——远山山脊按事件帧的太阳高度反算摆位 | `shots/s2.js` 的 `crestY` | animation §5.4 |
| 画风注册：后期数值全部来自 `beiming-original@v1` 的预设，镜头不另写一份 | `main.js` 的 `preset()`；`engine/style/` | STYLE-LOCK.md |

- **《北冥》10 秒样片** `src/`：镜头 A（黄浦江大远景，十几层底板的透视视差、一拍三的鲲、一拍二的鸽群）/ B（人物逆光近景，Canvas 2D 人物 + 抠像面片）/ C（第一视角仰望，穹顶面片、近景鲲、眼镜显示层）；后期配方 `src/look.js`，色板与材质预设 `src/toon.js`，声音 `audio/`。参考帧 `media/shot_*.jpg`，画风登记为 `beiming-original@v1`。
- **造型与材质变体**：六种鲲（`media/styles.jpg`），模块与自测页的对照、认可状态见 `engine/style/registry.json` 的 `variants.kun`。
- **模块自测页** `lab/`：经根目录 `index.html?test=<名字>` 打开，例如 `node engine/render/still.mjs . 1.0 --query test=look --out out/lab`；每页验证什么、是否走正片后期见 [lab/README.md](../../lab/README.md)。
- **深入阅读**：[北冥风格手册](../../docs/routes/beiming-style.md)（真实参数、变量实验）、[渲染与 4K](../../docs/渲染与4K.md)、[导演方法](../directing/README.md)。
