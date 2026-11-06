# 《见龙》工程架构（印刷水墨版，194.5 s）

给分段导演、作曲、合成看的工程说明。硬规范以 `~/Desktop/见龙/制作规范.md` 为准；时间以 `~/Desktop/见龙/timeline.json` 为唯一来源（可读版 `时间表.md`），任何人不得改总时间表和旁白起点。

- 工程：`@@WORKSPACE_ROOT@@/Desktop/见龙/jianlong/`（下称 `$P`）
- 库：`LIB=@@LEMO_ROOT@@`。渲染命令都在 `$LIB` 下执行；页面里库文件用 `/core/...`，工程文件用 `/@film/...`。
- 输出：1920×1080，30 fps；分段渲染 `--workers 2`；超过 2 分钟的命令放后台。
- 示范段：S01 开场已按本架构做完，成片 `$P/out/segs/S01.mp4`，代码 `src/segs/S01.js` + `sfx/S01.json`，照着写。

---

## 1. 目录与归属

| 路径 | 内容 | 谁能改 |
|---|---|---|
| `src/main.js`、`src/core/*.js` | 页面入口、共用模块 | 只有架构 |
| `src/segs/Sxx.js` | 每段一个画面模块 | 该段导演 |
| `sfx/Sxx.json` | 每段音效清单（也是本段画面动作的时刻表） | 该段导演 |
| `music/score.wav` | 全片配乐（194.5 s，48k/44.1k 立体声） | 作曲 |
| `tools/*.py`、`tools/*.sh`、`build.sh` | 预处理、混音、自检、出片 | 只有架构 |
| `data/` | timeline 副本、字幕、逐字时间、旁白包络、白名单 | 只由脚本生成 |
| `assets/` | 刻线图版、深度、水墨原画、宣纸、字体 | 只由脚本生成 |
| `material/` | 19 张原图（从临时目录复制来的唯一留底） | 不动 |
| `out/`、`stills/` | 渲染产物 | 各自的 |

分段只改自己的两个文件。需要共用件加功能（新界面组件、新音效类型、改图版参数），找架构。

## 2. 素材与预处理（全部可重跑）

| 脚本 | 做什么 | 产出 |
|---|---|---|
| `tools/prep.py [图号…]` | 现在段刻线：亮度均衡（mix 0.55）→ 放大 2× → period 13 刻线；保留红/黄/绿；近景人脸（图 2、3、4）局部拉对比 + 提亮 + 细刻线（period 7）+ 五官 DoG 勾线；按区域禁红/禁黄 | `assets/plates/pNN.png`（3840×2160）、`pNN_eq.jpg`、`assets/ink/iNN.jpg`、`assets/paper.jpg`、`assets/preview/` |
| `tools/depth.py [图号…] [--da 目录]` | 手工多边形分层（960×540 标注，从远到近覆盖，`grad` 层纵向渐变）+ 原图灰度引导滤波贴边；山景图 1、6、9、10、19 分了更多带；闪回 13–18 按画面线索自动估（只给轻微纵深）。`--da` 可融合 5090 Depth Anything 结果（0.5/0.5） | `assets/depth/dNN.png`、`assets/preview/dNN.jpg` |
| `tools/subs.py` | 旁白逐字时间戳（`data/subs_raw/nXX.titles`，已从会过期的链接下载存档）→ 字幕：小句最优分行，每行 ≤18 字，行尾标点去掉；显示 ≥ max(1.8 s, 念完+0.6 s) 且不压下一条 | `data/subs.json`、`data/words.json`、`jianlong.srt` |
| `tools/voenv.py` | 旁白 30 fps 响度包络（录音波形用） | `data/vo_env.json` |
| `tools/fonts.py` | Noto Serif SC 500/700/900、Noto Sans SC 500，Google Fonts `&text=` 子集（字集 = 白名单 + 字幕） | `assets/fonts/*.woff2` |

调图版明暗/禁色区：改 `tools/prep.py` 顶部 `CFG`（bright、mix、period）、`FACES`、`NORED`、`NOYEL`，重跑该图号。调深度：改 `tools/depth.py` 的 `LAYERS[图号]`，重跑该图号，看 `assets/preview/dNN.jpg`。

## 3. 坐标约定

- **屏幕坐标**：1920×1080 像素，原点左上，y 向下。2D 叠层（界面、字、雨）都用它。
- **图坐标**：原图 1920×1080 像素。刻线贴图是 2×，但一律按 1× 图坐标写。
- **相机** `cam = { cx, cy, zoom, sx, sy, push, depth }`：
  - `cx, cy`：屏幕中心对准的图坐标，默认 960, 540。
  - `zoom`：1 = 整图正好铺满。有视差位移时要 ≥ 约 1.06，否则边角会露出图外（控制台会警告 `[P] … 相机露出图外`）。
  - `sx, sy`：深度 = 1 处的屏幕视差位移（像素）。规范：近景最大约画宽 3% ≈ 58 px。
  - `push`：深度 = 1 处的额外放大（推镜时近景放大得比远景快，0.03–0.08 为宜）。
  - `depth`：深度强度倍数，默认 1；水墨闪回用 0.4–0.6。
- **投影公式**（CPU 与着色器同一套）：`屏幕 = (I − C)·s(w) + shift·w + 屏幕中心`，`s(w) = zoom·(1 + push·w)`，`w = depth·D(I)`。着色器对每个屏幕像素做 3 次反向迭代求图坐标，再 2×2 超采样取 2× 刻线贴图，所以**线条锚在画面上随推镜一起走，不在屏幕上游动**。
- 任何要跟着画面里某个东西走的界面元素（扫描框、标签引线、描山形），一律用 `api.P.toScreen(图版, cam, ix, iy)` 求屏幕位置，不要手填屏幕坐标。
- 深度：0 = 最远，1 = 最近。

## 4. 分段模块接口

### 4.1 `src/segs/Sxx.js`

```js
import { clamp, seg, eo, eio, ss } from '/core/lib.js';   // 库的缓动与工具
export const uses = ['p03', 'p02'];          // 本段要预载的图版（深度自动跟着载）
export const exit = () => ({ plate: 'p03', cam: B /*, 其他交接信息 */ });   // 本段最后一帧的样子，给下一段接
export function render(lt, api) { … }        // lt = 段内秒（0 … 段长），每帧调用一次，必须确定性
```

图版编号：`pNN` 现在段刻线版（图 1–12、19）；`iNN` 闪回水墨原画（图 13–18）；`eNN` 现在段亮度均衡的彩色图（过渡取亮度用，一般用不到）。

`render` 里的规矩：
- 不许 `Math.random()`、`Date.now()`、跨帧状态；随机用 `hash(n)` / `mulberry(seed)`（`/core/lib.js`）。
- 画面动作的时刻从 `api.cue('id').t` 取（对应 `sfx/Sxx.json` 的事件），**不要在 JS 里另写一个数**——这样画面和声音同源，误差 0 帧。
- 画的顺序 = 叠的顺序：先 `P.draw`（画面层，WebGL），再 `rain`/`veil`、`ui.lens`、标签（2D 叠层）。字幕由核心最后统一画。
- 画面上的字只能用规范 §4 白名单（`data/whitelist.json`），不在名单里的字 `ui.text` 会直接抛错，渲染失败。

### 4.2 `api` 一览

| 成员 | 用途 |
|---|---|
| `lt, T, dur, seg, kind` | 段内秒、全片秒、段长、时间表行、`'present'`/`'flash'` |
| `clear('ink'｜'paper')` | 清画面底色（现在段默认墨，闪回段默认纸） |
| `P.draw(id, cam, o)` | 画一张图版。`o.alpha`；`o.lod`（模糊）；`o.blob {mix, lod, th, soft}`（按图的暗部出墨块）；`o.mask {p, scale, soft, seed, radial, center:[x,y], rim, invert}`（溶解遮罩，噪声锚在图坐标上，n > p 处可见，`radial` 负值 = 边缘先消失，`rim` = 化开处的墨晕）；`o.tone {gain, desat, inkDark}`；`o.allowEdge` 关掉出边警告 |
| `P.toScreen(id, cam, ix, iy)` / `P.toImage(id, cam, x, y)` / `P.depthAt(id, ix, iy)` | 世界↔屏幕（同一公式） |
| `camLerp(A, B, k)`、`cam(o)` | 相机插值（zoom 按对数插值）、补齐默认值 |
| `ink.fadeToPaper(id, cam, k)` | 铺垫①：刻线褪成宣纸（边缘先化、中心最后、带墨晕边）。只用在 S12 |
| `ink.bloom(id, cam, k)` | 铺垫②：白纸上按图的暗部洇出模糊墨块轮廓 |
| `ink.develop(id, cam, k)` | 铺垫③：墨晕散开、水墨原画完整显影（接在 bloom(k=1) 后面连续） |
| `ink.recede(fromId, fromCam, toId, toCam, k)` | S18：水墨退去，刻线从墨洞里回来 |
| `rain({amt, layers, wind, speed, shiftX, shiftY, clip, alpha})` | 两到三层纸色雨线，近层快且粗；`shiftX/shiftY` 传当前 `cam.sx/sy` 得视差；`clip` 屏幕多边形（室内镜头只在窗外下雨） |
| `veil(kind, k, o)` | 穿越幕：`'fog'` 雾（横向纸色刻痕）/ `'rain'` 雨帘 / `'ink'` / `'paper'`。出段 k 0→1，入段 1→0，交接帧两边 k 相同 |
| `ui.lens({k, corners, dark, darkK, alpha})` | 镜片框：圆角框逐笔描出、四角绿角标收拢、框外压暗。`alpha` 0 = 镜片退去 |
| `ui.label(ev, lt, x, y, {size, leader, out, id})` | 绿色标签：框描出（0.25 s）→ 字逐个打出。`ev = api.cue('xx')`，事件里写 `text`、`cps`；打字声用同一事件，节拍自动对齐 |
| `ui.corners(box, k)` | 扫描角框从外收拢到 box |
| `ui.stroke(pts, k, {w, color, glow, alpha})` | 线条逐笔描出（描山形、心跳线、引线） |
| `ui.wave(x, y, w, h, T, level)` | 录音波形；`level = api.voLevel` 接旁白真实响度 |
| `ui.progress(x, y, w, p)`、`ui.dot(x, y, r, a)` | 回放进度条、录音指示点 |
| `ui.text(s, x, y, {size, font, color, align, alpha, id, full})` | 画字（查白名单、登记阅读检查）。字体：`'"JLSerif500"'`/`700`/`900`、`'"JLSans"'` |
| `ui.cutText(s, x, y, k, o)` | 刀刻式从左到右切出（片名） |
| `ui.inkChar` / `ui.vText` / `ui.seal(x, y, size, k)` | 宣纸上墨字落下 / 竖排小标题 / 朱红「闪」印压下 |
| `ui.flashTitle(字, 标题, {char, title, seal})` | 闪回统一版式：右上大字 + 竖排小标题 + 朱红「闪」印 |
| `post.blur / glitch / print / paper / vig` | 终合成参数（每帧重置）：失焦（mip 级，0–5）、镜片干扰（错色+行错位+扫描线，0–1，S07 用）、印刷呼吸强度、纸纹强度、暗角 |
| `words()` | 本段旁白逐字时间 `[{w, t0, t1}]`（段内秒），逐字出字、口诀一字一字亮起时用 |
| `voLevel(T)`、`vo` | 旁白响度 0..1；本段旁白信息 |
| `hideSub(cueId)`、`subStyle('present'｜'flash')` | 该句字幕由画面里的字代替时隐藏（如 S01 片名下小字）；强制字幕样式 |
| `prevExit()` | 上一段 `exit()` 的返回值：从上一段的最后一帧接着画，实现不硬切 |
| `ctx`、`C` | 2D 叠层画布和色板（`C.ink #16171b`、`C.paper #ede5cd`、`C.red #c4332b`、`C.yel #dfa443`、`C.grn #3DFFB0`） |

"掉帧一格"（S07）：在 `render` 开头把某一帧的 `lt` 改成上一帧的值（`if (Math.abs(lt - X) < 1/60) lt -= 1/30`），只此一帧。

### 4.3 `sfx/Sxx.json`

```json
{ "seg": "S05", "events": [
  {"id": "play",  "t": 0.6, "type": "rec_beep", "gain": -18},
  {"id": "deer",  "t": 3.2, "type": "ui_type", "text": "鹿影", "cps": 10, "gain": -24},
  {"id": "rainA", "t": 0.0, "type": "rain_far", "dur": 9.5, "gain": -18, "fade_in": 0.5}
]}
```

- `t` 是**段内秒**；`id` 给画面用 `api.cue(id)`；`gain` dB（默认 −12），`pan` −1..1，持续类要 `dur`，可加 `fade_in/fade_out`、`seed`。
- 音效类型（`tools/sfx_kit.py` 的 `TYPES`，均为程序合成）：`rain_far` `rain_near`（雨两层）、`car_sweep`（车灯扫过，`pan_from/pan_to`）、`window_paper`（窗纸）、`rec_beep`（录音器提示）、`ui_stroke`（描线，很轻）、`ui_tick`、`ui_type`（打字，`text`/`n`、`cps`）、`scan_beep`（扫描嘀）、`glitch`（干扰）、`lens_focus`、`mudslide`（泥石流低频）、`headlamp`、`footsteps`（`n`、`rate`）、`stone`、`heartbeat`（`n`、`bpm`，第一声对准 t）、`assemble`（归位木石碰撞，`n`+`dur` 或 `times`）、`paper`、`ink_bleed`（墨洇）、`brush`（毛笔擦纸）、`char_thud`（大字落下闷响）、`seal`（印章）、`title_cut`（片名刀刻）、`whoosh`（穿越）。缺类型找架构加。
- 试听某类：`$LIB/.venv/bin/python tools/sfx_kit.py heartbeat` → `out/sfx_preview/heartbeat.wav`。
- 雨床要每段自己铺（两层），交接处前后段各自淡入淡出 0.3–0.5 s，避免雨声断档。

## 5. 段与段交接（不硬切）

- 每段 `exit()` 给出最后一帧的图版和相机（可以加 `rain`、`veil` 等）；下一段 `render` 开头用 `api.prevExit()` 拿到，**从同一画面接着画**，再推镜穿过窗格/雨幕/雾/镜片进入自己的图。
- 两段的交接帧必须一致：上一段在 lt = 段长 时的样子 = 下一段 lt = 0 时的样子。自检：`tools/still.sh 上一段 at <段长−0.034>` 与 `tools/still.sh 下一段 at 0` 两张并排看。
- 已定的交接：S01 → S02：图 1、相机 `B`、雨量 1.25、雨帘 `veil('rain', 0.6)`。S02 开头把雨帘退到 0。
- 规范硬要求：S03 从窗外（图 2 的亮窗）一路推进窗里看到老人（可在 S03 里先画 `p02` 再进 `p03`）；S07 用 `post.glitch`；S12 有"刻线褪成宣纸"，S13–S17 从上一段水墨直接洇进；S18 水墨退去 → 刻线龙山 → 镜片标六部件 → 镜片退去。
- 占位版：S02–S11、S19 现在是"图版 + 慢推 + 镜片框"的占位；S12–S18 已是能出片的水墨铺垫骨架（用了 `ink.*` 与 `flashTitle`），分段导演直接在上面改或整个重写。

## 6. 分段自检

```sh
cd @@WORKSPACE_ROOT@@/Desktop/见龙/jianlong
sh tools/still.sh S05            # 每 0.5 s 一张 → stills/S05_sheet.jpg（联系表）
sh tools/still.sh S05 0.2        # 步长 0.2 s（关键动作逐帧看）
sh tools/still.sh S05 at 0 4.8 9.466   # 只出指定段内时刻 → stills/S05/t_*.jpg
sh tools/seg.sh S05              # 分段视频（画面 + 旁白 + 本段音效 + 配乐）→ out/segs/S05.mp4，并做黑帧检查
$LIB/.venv/bin/python tools/textcheck.py               # 画面文字白名单静态检查
cd $LIB && node core/render/readcheck.mjs @@WORKSPACE_ROOT@@/Desktop/见龙/jianlong --q seg=S05   # 画面文字阅读时长
```

交付前自查：
1. 联系表看两遍：主体够大、不贴边；无整屏纯墨/纯纸超过 0.5 s（设计的黑场除外）；字幕不压主体。
2. 交接帧与上一段 `exit` 一致。
3. 近景脸（图 2、3、4）放到原尺寸看五官神情。
4. 画面文字只有白名单；`readcheck` 通过；`ui.label` 的 `text` 也在白名单。
5. 色彩：红只给灯笼门联（`C.red` 不画在别处，「闪」印除外），黄只给灯光，绿只给眼镜界面和原画绿光。
6. `seg.sh` 结尾打印的响度在 −14±1 LUFS，真峰值 ≤ −1 dBTP。

## 7. 声音

- `tools/mix.py [--seg Sxx]`：旁白按 `vo.start` 落位（不改速度，先压缩再按 RMS 对齐到 −20 dBFS）；配乐读 `music/score.wav`（基准比旁白低 6 dB）；音效读所有 `sfx/*.json`；侧链：说话时音乐 −12 dB、音效 −5 dB（起 60 ms、放 450 ms）；两遍 loudnorm 到 −14 LUFS、TP −2.2（给 AAC 过冲留余量），实测打印。
- **作曲**：交 `music/score.wav`，全片 194.5 s，从 0 秒对齐时间表；情绪曲线见规范 §3；S10 几乎静默只留心跳（心跳声在 S10 的 sfx 里，由画面同步）。来源优先 5090 的 MiniMax-Music3（如 `~/.claude/projects/-Users-cuiqq/memory/rog-depth-music3.md` 存在且可用），否则用 `$LIB/core/audio/sampler.py`/`pluck.py` 写代码配乐。
- 母带再由 `mux.sh` 校一遍到 −14 LUFS。

## 8. 整片

```sh
cd @@WORKSPACE_ROOT@@/Desktop/见龙/jianlong && sh build.sh        # 放后台；RENDER_SLOTS=4，--workers 4
sh build.sh prep                                              # 连素材预处理一起重做
```
产出 `jianlong.mp4`、`jianlong.srt`、`poster.jpg`（默认取 6.5 s，`POSTER_T=秒` 可改）。`TREATMENT.md`、`CREDITS` 由合成在交付时补齐。

## 9. 注意事项

- 页面在全片模式会一次载入全部 19 张图版（每个 worker 约 0.7 GB 显存）；分段模式只载本段 + 上一段 exit 的图版。
- 渲染速度：S01 9.5 s（285 帧）2 个 worker 约 13 s。
- 图版明暗按已验证样片（mix 0.55，bright 1.2–1.3），比用户选定静帧更亮一些；若某段要更暗的夜色，找架构调该图 `CFG.bright` 重出，不要在着色器里压灰（会出第三种灰，违反"只有墨与纸"）。
- 原画里本来有的字（图 5、6、9、11、12 的口诀浮标与"前方两米，有心跳声。"等）可以照原样保留，但代码不得再画白名单外的字。
- 成片与交付文件里不得出现库作者署名或库名（规范 §5 末条）；只允许在 `LIB=` 路径里出现。

## 10. 合成记录（2026-11-03）

整片按 §8 出片：`jianlong.mp4`，5835 帧，194.500 s，−14.0 LUFS，真峰值 −1.3 dBTP。合成改过以下文件，原文件备份在 `out/*.bak`：

| 文件 | 改动 | 原因 |
|---|---|---|
| `src/core/ui.js` `lens()` | 虚线改为 `[per·k, per·(1−k)+0.01]`，周期等于周长 | 原写法在 k=1 时，镜片框左上约 8% 的边（顶边 x≈150–580）一直缺着，S01–S09 都受影响。S06 导演报告过 |
| `tools/sfx_kit.py` | 所有 `int(d * SR)` 统一成 `int(round(d * SR))`，和 `T()` 一致 | 原来两种取整混用，`rain_far dur 4.6`、`ink_bleed dur 4.1` 这类时长会因数组差一个采样而报错。S04、S16、S17 导演报告过，他们当时用改时长绕开了 |
| `src/segs/flashkit.js` | S12 开头的镜片淡出改为读 `prev.lens` 的数值（S11 交出 `lens: 0`）作起始透明度 | 原来只认 `lens === false`，S11 交出的是 0，所以 S12 第一帧镜片框和压暗突然冒出来（帧差 10.6，前后帧约 0.5）。修后交接帧差 1.17 |
| `src/segs/S07.js`、`S08.js` | 入段换图从硬切改为在雨帘最满处叠化 0.16 s（S07：0.17–0.33 s，S08：0.12–0.28 s） | 雨帘最满时画面亮度仍有约 30%，帘后的换图能看出是一下跳切（帧差 9.6、11.0，前后帧约 3）。修后整片没有孤立的单帧跳变 |
| `music/README.md` | 去掉正文里的库名 | 规范 §5：交付文件除 `LIB=` 路径外不出现库名 |
| `build.sh` | 海报默认取 8.6 s（片名和副题都已打全），末尾打印帧数、响度、真峰值 | 6.5 s 时副题只打出一半 |

还没修的共用件问题（不影响成片画面）：`ui.inkChar` 在平移后的局部坐标里登记文字位置，readcheck 会误判大字在画外。闪回各段已改用 `ui.text` 绕开。

## 11. 返修记录（2026-11-03，审片 6/10 的 12 条）

原文件备份在 `out/*.bak`、`out/bak_sfx/`。

| 文件 | 改动 | 对应审片 |
|---|---|---|
| `tools/prep.py` `CFG` | 现在段 mix 0.55 → 0.3，bright 按图解到图版平均亮度约 62（原 114–132）；成片现在段平均亮度约 55–75，接近选定静帧 | 1 |
| `tools/prep.py` `FACES`/`KEEP` | 新增脸部"平涂模式"`mode='flat'`（亮度大半径抹平 → 纸色/等宽细刻线/实墨三档 + 五官轮廓，去掉面积小的墨点）：图 2 阿山、图 4 两人、图 10 老人；图 4 老人椭圆收紧。`KEEP[10]` 白石局部保亮 | 2、7 |
| `tools/prep.py` `PATCH` | 图 11 提示框「前方两米，有心跳声。」按原画原样贴回，不做刻线 | 3 |
| `tools/prep.py` `NORED`/`NOYEL`/`YSMALL` | 图 10、11、12、19 去红；图 10、11 去黄；图 12、19 的黄只留小块的光（龙眼、灯） | 11 |
| `sfx/S10.json` | 加 `room`（远雨底，成片约 −48 dBFS），不再有数字零电平 | 3 |
| `sfx/S12–S17.json`、`src/segs/flashkit.js` | 墨洇缩短、显影在旁白起点后约 1.5 s 完成；`BLOB_LOD` 5 → 4（模糊半径减半） | 4 |
| `src/segs/S02.js`、`S03.js` | 推窗曲线重写：S02 后 3 s 推向亮窗并把窗心移到画面中间；S03 去掉通用窗棂叠层，在图 2 那扇窗本身上推进、1.35 s 线性化开穿过去 | 5 |
| `src/segs/S06.js` | 入段换图改为 0.17–0.43 s 叠化，雨帘退开 0.62 → 0.9 s | 6 |
| `tools/subs.py` | 句中标点计入每行字数（≤18） | 8 |
| `src/segs/S18.js` | 相机改为贯穿全段的上升推近（cy 620→470，zoom 1.08→1.34，sy +34→−30，push 0→0.10） | 9 |
| `src/segs/S19.js`、`sfx/S19.json` | 印章 0.55 s 落定，主句 0.6 s、小字 0.65 s 起，最后 0.5 s 淡到纸色 | 10 |
| `tools/mix.py` | loudnorm 前加限幅（加增益后 ≤ −4 dBFS），TP 目标 −3.0 | 12 |
| `sfx/S07.json` | 泥石流 −3 dB | 12 |
| `music/README.md`、`music/score.py` | 库路径只出现在 `LIB=` 行 | 12 |
| `CREDITS` | 补写图 11 贴回原画、图 10/11/12/19 去色 | — |

注意：S02 推窗末段画面左缘会露出图 2 的左边界外一条（图版贴边取样，刻线是横线，所以是延长的横纹墨色），穿窗化开时最宽约 300 px，在镜片框压暗里。

## 12. S18「见龙」重做（2026-11-03，用户审片：「3:06 结尾的龙不够有张力」）

只改了 S18；其它段、配乐、旁白、timeline、mix.py 都没动。改前文件备份在 `out/bak_s18v1/`（S18.js、S18.json、gl.js、plates.js、sfx_kit.py）。分段成片 `out/segs/S18_v2.mp4`（12.000 s，−14.2 LUFS，峰值 −3.2 dBFS，无黑帧；混的是旧 n17 旁白，新旁白还没进 data/），联系表 `out/segs/S18_v2_sheet.jpg`（176.0–187.5 s 每 0.5 s 一帧，4×6）。readcheck 六个标签全过，textcheck 通过。

**节奏**（段内秒 / 全片秒，时刻全部在 `sfx/S18.json`）：

| 段内 | 全片 | 画面 | 声音 |
|---|---|---|---|
| 0–2.6 | 176.0–178.6 | 水墨退去、刻线龙山浮出（同原版） | 墨洇 |
| 1.6–6.1 | 177.6–182.1 | **压**：画面压到 0.72 亮度、暗角加深；低机位极慢蠕动；刻线雾横在龙头和山腰前，龙头半藏；一道绿扫描线慢慢扫下去 | 蓄力低鸣（`drone`）由无到有 |
| 4.3 / 5.3 | 180.3 / 181.3 | 两次预震，镜头轻抖 | `quake` 小 |
| 5.6 | 181.6 | 龙吸气，眼光在雾里闪一下又灭 | `breath` 吸气 |
| 6.1–6.5 | 182.1–182.5 | 镜头下沉、后缩（蓄力） | 低鸣末尾倒吸气冲到顶 |
| **6.5** | **182.5** | **爆发**：龙眼黄光亮起（带横向光芒）、全画面一闪、龙头一团光；镜头 0.55 s 猛推急升（人往下沉、龙头抬上来），龙头局部隆起逼近；两圈气浪推开，雾被吹散；光沿右侧龙脊（红色火线）从龙头扫到山脚、左侧山脊一道弱光；镜头重震 | 大鼓一击（`boom`）+ 山体震动（`quake`）+ 气浪（`gust`）+ 扫光 `whoosh` |
| 6.62–7.64 | 182.62–183.64 | 绿线从龙角起沿龙身一节节走，依次标出 角、眼、心、脊、鳞、爪（每节 0.18 s） | 嘀声音高逐级升 + 打字 |
| 7.2–12 | 183.2–188 | 龙首压在画面上，镜头持续缓推 | 平稳山体低鸣（`drone rise=0`） |
| 9.35 / 9.5 | 185.35 / 185.5 | 标签收 / 镜片退去 | ui_tick / lens_focus |
| 10.0 | 186.0 | 龙一口长呼气：眼光随之一涨、龙头微微一涨；雾从两侧山腰重新流过来 | `breath` 呼气 |
| 11.35–11.95 | 187.35–187.95 | 光与雾收掉、镜头缓停 → 交给 S19 | |

爆发点放在新旁白「原来，山脊就是龙背，梯田就是鳞甲。」与「世事变迁……」之间的停顿里（按旧录音语速推算约 182.3–183.4 s，新录音还没有，未实测）。**新旁白定稿后若停顿不在 182.5 s：把 `sfx/S18.json` 里 `burst` 及其后所有事件整体平移同样的秒数即可**（画面全部按 cue 走；`labels_out`、`lens_off` 要保证最后一个标签「爪」在画面上 ≥1.72 s，readcheck 会查）。

**共用件的向后兼容新增**（不传新参数时与原来逐像素一致）：
- `src/core/gl.js`：相机新增 `hx, hy, hr, ha`（局部隆起：图坐标 (hx,hy) 附近按高斯 `exp(−d²/hr²)` 额外放大 `ha`，深度 > 0.62 的近景渐不受影响，所以人不会跟着变形）。着色器 `toImg` 里 `s *= 1 + ha·bump`，`ha = 0` 时跳过；`normCam` 补默认值 `ha: 0`（`camLerp` 按数值插值照常可用）。S18 用它让龙头单独"逼近"（段尾 ha = 0.08，呼吸时 ±0.006，呼气 +0.014）。
- `src/core/plates.js`：`toScreen` / `toImage` 同式加入隆起系数，跟画面走的标签、光斑仍然锚得住。
- `tools/sfx_kit.py`：新增 5 种音效类型（只加不改）：`drone`（低频轰鸣，`rise=1` 蓄力到结尾并带倒吸气，`rise=0` 平稳低鸣）、`boom`（大鼓一击 + 次低频长尾，双声道）、`quake`（山体震动 + 碎石，`attack`）、`gust`（气浪，左右先后推开）、`breath`（龙的呼吸，`inhale=1` 吸气）。均为程序合成，无外部采样，CREDITS 不需改。

**S18 模块内的做法**（`src/segs/S18.js`）：
- 雾不用半透明笔触（会变成灰色横条、像干扰），而是"刻线雾"：每隔一个刻线周期画一行纸色实线，线宽随雾的浓度变化（与图版表现明暗同法，不出第三种灰）；雾在人和脚下岩石处按深度让开。
- 光沿龙脊扫过 = 同一图版模糊提亮后，用跟着山脊走的径向遮罩只露一团光斑，叠层上再加一团暖黄。
- 爆发前的"暗"用 `tone.gain` 0.72 + 暗角，爆发那一帧回到 1。
- 闭眼：图版里龙眼本来就是亮的，爆发前用两团横长杏仁形墨压住（随水墨退去才压上，不会落在水墨图上），吸气时睁开一条缝，爆发那一帧睁开。
- 段尾 11.35–11.95 s 光、雾、呼吸全部收成 0，最后一帧 = `exit()` 相机、无叠层；与 S19 首帧平均像素差 2.2、S17 末帧与 S18 首帧差 1.9（与相邻两帧的印刷呼吸同量级）。
- 段尾近景视差收小（push 0.08、sy 4）：试过 push 0.12–0.14，人物肩线两侧刻线出现锯齿。

## 13. 第二版旁白（2026-11-03，用户：旁白换音色、换新稿、加速；其他画面不改）

改前文件全部备份在 `out/bak_vo2/`（`root/` 是 `~/Desktop/见龙/timeline.json`、`时间表.md`；`data/` 含旧逐字时间戳 `subs_raw/`、`subs.json`、`words.json`、`vo_env.json`、`whitelist.json`；`tools/` 是旧 `mix.py`、`voenv.py`、`subs.py`、`build.sh`；`fonts/` 旧字体子集；`mix_v2pre.wav`、旧 `jianlong.srt`、`poster.jpg`）。上一版成片 → `out/jianlong_v2pre.mp4`，上一版整片画面 → `out/video_v2pre.mp4`（像素对比用）；`out/jianlong_v1.mp4` 未动。

**旁白**：新稿 `~/Desktop/见龙/旁白v2/lines.json`（18 句，编号与段的对应同旧稿，S10 无旁白），录音 `旁白v2/wav/nXX.wav`（44.1k 单声道，音色 Chinese (Mandarin)_Sincere_Adult），逐字时间戳用已下载的 `旁白v2/wav/words/nXX.json`（原 json 里的链接会过期），已拷成 `data/subs_raw/nXX.titles`。`tools/mix.py`、`tools/voenv.py` 的 `WAV` 改指 `旁白v2/wav`。

**timeline.json**：段落边界与总长 194.5 不动；每段 `vo.text`、`vo.dur` 换成新稿/新时长；旁白起点只动了两句，其余 16 句在原起点（新录音都比旧的短，全部在段尾前念完，最紧的是 S13：124.343 / 124.5）：

| 句 | 起点 | 原因 |
|---|---|---|
| n04（S04） | 35.0 → **35.344** | S04 画面在 40.011 s（段内 5.511，`sfx/S04.json` 的 `yao`）有「要」字冲击帧和「要记住。」压字，`S04.js` 会校验 yao 与旁白「要」相差 ≤1 帧，否则渲染直接报错。按原起点新录音的「要」在 40.167，差 0.344 s。选择挪旁白而不是挪 `yao`，S04 画面一帧不改；代价是「抓住」比画面的抓手（36.2 s）晚约 0.27 s 念到。 |
| n17（S18） | 178.5 → **177.9** | 让 S18 的爆发点（`burst`，182.500 s）落在「……鳞甲。」与「世事变迁」之间的停顿里。没有平移 `sfx/S18.json`，S18 画面保持 §12 的版本。 |

S18 实测（n17 录音 5 ms RMS 能量，−50 dBFS 阈；括号内为 −40 / −60 dBFS 阈）：「甲」结束 182.242（182.202 / 182.262），爆发 182.500（画面第 5475 帧亮度 59 → 97；混音 10 ms 能量 182.49 → 182.50 由 −20 跳到 −8 dB），「世」起音 183.067（183.082 / 182.987）。爆发在「甲」后 0.24–0.30 s、「世」前 0.49–0.58 s。

**字幕**：`tools/subs.py` 规则不变，重出 `data/subs.json`、`data/words.json`、`jianlong.srt`（44 条，最长 18 字）。短于 1.8 s 的三条是规则内的强制结果（下一条紧接着开口）：`n02_0`「暴雨初歇」0.69 s、`n04_0` 1.50 s、`n06_0` 1.64 s。

**白名单 / 字体**：`data/whitelist.json` 加 `vo`（新稿 18 句 zh），并入 `all`；`tools/fonts.py` 重出字体子集（新字如 员、随、比、第、祖、孙、锤……）。`textcheck` 通过。

**录音波形**：`tools/voenv.py` 按新录音重出 `data/vo_env.json`（S04、S09 的波形接旁白真实响度）。

**混音**：`tools/mix.py` 只换了旁白路径，其余流程不变（曾按要求加过"老人的歌"轨，用户已取消，代码已整段删掉，`mix.py`、`build.sh` 回到原版 + 新 `WAV`）。

**出片**：`sh build.sh`（RENDER_SLOTS=4，画面 91 s）。`jianlong.mp4`：5835 帧，194.500 s，−14.0 LUFS，真峰值 −1.7 dBTP（`mix.wav` −14.1 LUFS / −2.5 dBTP）。18 句旁白在成片音轨里互相关落位与 timeline 一致（全部 +2 ms，为 AAC 编码延迟，相关系数 0.70–0.95）。

**画面与上一版对比**（`out/video_v2pre.mp4` 对 `out/video.mp4` 逐帧，960×540 灰度，屏幕 y 940–1030 字幕区除外）：除下列地方外，所有帧最大像素差 ≤ 40、均差 ≈ 0.5–1.2（编码噪声量级）。有实质差别的只有：
- S01 4.70–7.80 s：片名下小字（n01）逐字出现的时刻跟新录音走；
- S04 35.20–41.83 s：录音波形（接旁白响度）、「要记住。」后三字随新录音更快压进；
- S09 82.27–84.77 s：录音波形（接旁白响度）；
- S18 176.6–188.0 s：§12 的重做版本（上一版成片里还是旧 S18）；S19 188.00–188.53 s：S19 从 S18 新的 `exit()` 接起。

**仍未处理**：
- S12–S17 闪回的小标题（`title` 事件，设计为"与旁白念到标题同步"）现在比新录音念到标题晚：S12 0.21 s、S13 0.11 s、S14 0.53 s、S15 0.20 s、S16 0.21 s、S17 0.35 s。要对齐可把这些段的旁白起点各往后挪同样秒数（都还能在段尾前念完，S13 只余 0.05 s），或改各段 `sfx` 的 `char/title/seal`（会改画面）。本次按"默认原起点、画面不改"未动。
- readcheck：S19 `end_line`（小字 22 字）需要 6.08 s、实得 5.82 s，判 BAD；与本次无关（S19 时刻来自 `sfx/S19.json`，本次 188.53 s 之后与上一版只有编码噪声量级的差别）。S04 单段检查 `yjz` 判 BAD（2.04 s）是因为字在 S05 开头还画着，按 34.5–52 s 窗口检查得 2.76 s，通过。
