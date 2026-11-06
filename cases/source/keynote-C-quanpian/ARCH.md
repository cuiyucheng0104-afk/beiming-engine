# 方案 C《打开》全片工程 · ARCH（架构说明）

> 给五位分章导演和一位作曲：只读这一份就能开工。规范以 `共用/方案C全片规范.md` 为准（总小节表、画面文字、IP 规则、音乐结构），开头的全部视觉决定在本目录 `TREATMENT.md`（开头那一版，原样继承）。
> 本文档里的"秒"都是全片时间（0–180 s）。

## 0. 硬规格与铁律

| 项 | 值 |
|---|---|
| 时长 | **180.000 s**，5400 帧，1920×1080，30 fps |
| 节拍 | 120 BPM，4/4，一拍 0.5 s，一小节 2 s，共 90 小节；第 n 小节第 1 拍 = `(n−1)×2` 秒 |
| 开头 | 0–20 s（第 1–10 小节）**锁定**：画面逐帧、声音逐采样与 `C-kaitou/C-kaitou.mp4` 相同（`tools/kaitoucheck.py` 验收） |
| 世界 | 一个 three.js 世界：同一张胡桃木桌、同一盏台灯、同一本群青布面书；章节之间不硬切 |
| 文字 | 只用 `src/shared/texts.js` 的白名单（= 规范 §2）；不写任何角注、计数、调试字 |
| 信号色 | 朱红 `#BE3A2E`（唯一信号色）；墨色 `#3A2A20`；纸件白边 + 灰纸板切口 |
| 字体 | 中文 Noto Sans SC（`SC` 700 标题 / `SCM` 500 小字），数字与拉丁 Inter（`InterF` 500/700/800） |
| 禁止 | 不出现 LemoLab / Opus 字样；不改 `@@LEMO_ROOT@@`、`共用/`、`C-kaitou/` |

**每帧都是 t 的纯函数**：不许用 `Date.now()`、无种子的 `Math.random()`、"上一帧的状态"。任何一帧都可能被单独渲染（3 个 worker 各渲一段、分段渲染、乱序出静帧）。

## 1. 目录结构

```
C-quanpian/
├── index.html                 页面（字体 @font-face、importmap）
├── build.sh                   一条命令出整片（架构）
├── ARCH.md / TREATMENT.md     本文档 / 开头的 TREATMENT（继承，不改）
├── CREDITS                    素材与许可（新增素材的人负责补一行）
├── events.json                导出物：全片事件表（build.sh / seg.sh 自动生成，别手改）
├── src/
│   ├── main.js                入口：render(t)、分段参数、window.EV / TEXTS / PROBE2（架构）
│   ├── timeline.js            全片唯一时间源（架构）：开头时间表 T + 章节表 CH + 翻页 BOOK + 关键时刻 KEY + 相机衔接 CAM_BRIDGE
│   ├── cover.js / stage.js / art.js   开头工程（锁定；stage.js 只加了导出与相机覆盖参数）
│   ├── shared/
│   │   ├── world.js           共用层：书页翻动/摊平/合书、台灯、相机衔接、章节调度（架构）
│   │   ├── kit.js             工厂：卡片、纸件、V 折页、文字、纸条标签、材质与 IP 图加载（架构）
│   │   ├── assets.js          资产表：IP 图与材质的键名 → 文件、归属章节（架构）
│   │   └── texts.js           画面文字白名单（架构；= 规范 §2）
│   └── chapters/
│       ├── ch2.js  ch3.js  ch4.js  ch5.js  ch67.js     ← 分章导演各写各的（现在是占位）
├── sfx/
│   ├── ch2.json … ch67.json   ← 分章导演各写各的音效清单（现在是占位）
├── sfx_kit.py                 共用音效库（架构；需要新类型找架构加）
├── music.py                   ← 作曲只写这个：全片配乐层 → out/music.wav（现在是节拍器占位）
├── kaitou_mix.py              开头原混音（锁定）
├── mix.py                     全片混音：开头原混音 + music.wav + sfx → 侧链 → −14 LUFS（架构）
├── material/                  IP 图（共用/IP图_超分）+ 材质（共用/材质），只读
├── fonts/                     开头三份子集（锁定）+ 全片子集 SC-700 / SC-500 / InterF-*
└── tools/
    ├── seg.sh <章>            分段：该章 mp4 + 每 0.5 s 联系表
    ├── still.sh <t> …         单帧
    ├── cuecheck.py            全片卡点 / 翻页 / 音效 / 文字自检
    ├── probe_full.mjs         逐帧状态 + 画面文字采样（cuecheck 的输入）
    ├── kaitoucheck.py         开头不变性（SSIM + 声音逐采样）
    ├── cuecheck_kaitou.py / probe.mjs   开头原来的对拍检查（0–20 s）
    ├── mux.sh                 封装（不再 loudnorm）
    ├── fonts.sh               按白名单重做字体子集（改了 texts.js 才需要）
    └── geo.mjs                在真实页面里求值一段 JS（几何调试）
```

## 2. 谁改哪些文件（并行不冲突的关键）

| 角色 | 可以改 | 不要改 |
|---|---|---|
| 第二章导演 | `src/chapters/ch2.js`、`sfx/ch2.json` | 其余全部 |
| 第三章导演 | `src/chapters/ch3.js`、`sfx/ch3.json` | 同上 |
| 第四章导演 | `src/chapters/ch4.js`、`sfx/ch4.json` | 同上 |
| 第五章导演 | `src/chapters/ch5.js`、`sfx/ch5.json` | 同上 |
| 第六·七章导演 | `src/chapters/ch67.js`、`sfx/ch67.json` | 同上 |
| 作曲 | `music.py` | 同上 |
| 架构（合成） | `timeline.js`、`shared/*`、`main.js`、`mix.py`、`sfx_kit.py`、`build.sh`、`tools/*`、`index.html`、`fonts/` | 开头文件 |

- 章节自己的新素材（生成的贴图等）放 `material/<章>/`（例如 `material/ch5/`），在 CREDITS 末尾加一行；用 `ctx.kit.img('ch5/xxx.png')` 加载。
- 需要改共用层（新增音效类型、改翻页时长、新增白名单文字、新的共用能力）时，**不要自己改**，在本章文件顶部注释里写"需求：……"，由合成阶段统一处理。
- 章节需要的、规范里没有的时刻，定义在自己模块里（用 `at()`），不要写进 `timeline.js`。

## 3. 时间轴 `src/timeline.js`

```js
import { at, bt, fq, BEAT, BAR, CH, BOOK, KEY, partRange } from '../timeline.js';
at(14)        // 第 14 小节第 1 拍 = 26.000（已量化到整帧）
at(53, 3)     // 第 53 小节第 3 拍 = 105.000
at(41, 2, 1)  // 第 41 小节第 2 拍再加 1 个十六分音符 = 80.625 → 量化到 80.633（整帧）
bt(…)         // 同上但不量化（音乐网格用）；fq(t) 量化到最近整帧
```

**画面落点一律用 `at()`**：八分、十六分音符不在整帧上，量化后画面与音效用同一个时刻，音画差 0 ms。

章节表 `CH`（range = 本章控制相机的区间；live = 本章图层可见、`update()` 被调用的窗口）：

| 章 | 小节 | range（秒） | 跨页 | 小段 parts（小节） |
|---|---|---|---|---|
| ch1 开场（锁定） | 1–10 | 0–20 | 1 | — |
| ch2 角色叙事 | 11–30 | 20–60 | 1（2a）、2（2b）、3（2c）、4（2d） | a 11–13 · b 14–19 · c 20–24 · d 25–30 |
| ch3 美术语言 | 31–48 | 60–96 | 5 | intro 31–32 · ink 33–36 · mural 37–40 · paper 41–44 · puppet 45–48 |
| ch4 新作品 | 49–61 | 96–122 | 6 | tower 49–50 · whale 51–52 · windows 53–55 · forest 56–58 · ranbiwa 59–61 |
| ch5 合作城 | 62–73 | 122–146（live 到 180） | 7（摊平） | grow 62–63 · fly 64–69 · doors 70–73 |
| ch67 洽谈与尾声 | 74–90 | 146–180 | 7 | steps 74–81 · folder 82–84 · tan 85–87 · close 88–90 |

规范点名的时刻 `KEY`（必须对齐，直接引用）：

| 键 | 秒 | 规范 |
|---|---|---|
| `KEY.ch2.stillStop` | 20.000 | 剧照卡升到朱红日轮前定住（第 11 小节第 1 拍） |
| `KEY.ch2.turnB / turnC / turnD` | 26 / 38 / 48 | 翻页（第 14 / 20 / 25 小节） |
| `KEY.ch3.turn / ink / mural / paper / puppet` | 60 / 64 / 72 / 80 / 88 | 翻页与四个档位 |
| `KEY.ch4.turn / whale / windows / forest` | 96 / 100 / 104 / 110 | |
| `KEY.ch4.silence` | 115.500 | 第 58 小节第 4 拍全静一拍 |
| `KEY.ch4.peak` | 116.000 | 第 59 小节第 1 拍：全片最强的一下（台灯转向打亮燃比娃） |
| `KEY.ch5.flat / fly / doors` | 122 / 126 / 138 | |
| `KEY.ch6.steps` | 146 / 150 / 154 / 158 | 四步，每两小节一步 |
| `KEY.ch6.folder` | 162 | |
| `KEY.ch7.tan / back / close / footer` | 168 / 174 / 176 / 178 | 合书 = 第 89 小节第 1 拍 |

## 4. 章节模块接口 `src/chapters/<章>.js`

一个模块 = 一个 ES 模块，导出下面这些（只有 `build`/`update` 是必须的）：

```js
import { at, KEY } from '../timeline.js';
import { camKey } from '../shared/world.js';
import { TEXT } from '../shared/texts.js';

export const ID = 'ch3';

// 相机关键帧：[全片秒, camKey(fov°, 仰角°, 方位°, 目标x, 目标y, 目标z, 画面可视高 m)]，只写本章 range 之内
export const camera = [[61, camKey(26, 24, 0, 0, .09, -.02, .34)], [72, camKey(25, 20, -8, 0, .09, -.02, .30)]];

// 台灯转场（可选）：{ t, dur, dim?, yaw?, aim?: [x,y,z], color?, env?, sound? }
export const lamp = [{ t: at(37, 1), dur: .2, dim: .6 }];

// 对外事件：画面落点。id 全片唯一（"<章>.<名>"），sfx: true = 必须有声音（cuecheck 会查）
export function events(ctx) { return [{ t: KEY.ch3.ink, type: 'notch', id: 'ch3.notch.ink', sfx: true }]; }

// 一次性搭建（可 async）：造纸件、加载图、挂到跨页或本章图层上
export async function build(ctx) { … }

// 每帧：t 是全片时间。只根据 t 设置自己的东西（纯函数）
export function update(t, ctx) { … }

// 可选：画面上的文字框（readcheck / 白名单检查）；可选：probe(t, ctx) 返回本章状态（写进 out/probe_full.json）
export function texts(t, ctx) { return [{ id: 'ch3.title', text: TEXT.ch3.title, ...ctx.screenBox(titleMesh) }]; }
export function probe(t, ctx) { return { notch: … }; }
```

**调用规则**
- `build()` 按 ch2 → ch3 → ch4 → ch5 → ch67 的顺序跑一次；后面的章节可以 `ctx.use()` 前面章节 `ctx.publish()` 的东西。
- `update(t)` 每帧调用，窗口 = 本章 `live` ∪ 本章所有跨页的可见窗口（跨页在上一页开始翻起时就露出来了，本章的纸件那时就要摆在"还没立起"的状态）。t < 20 s 永不调用。
- 每帧顺序：开头 `stage.update(20.000 冻结)` → 共用层（书、台灯、相机）→ ch2 → ch3 → ch4 → ch5 → ch67 → 渲染。后调用的可以覆盖先调用的（第二章可以接管开头的物件，第六七章可以接管城市）。
- 本章图层 `ctx.root`（= `ctx.layer(ID)`）在 `live` 之外自动隐藏；挂在跨页上的东西随跨页自动显隐。**在本章窗口之外露出的东西就是 bug**。

### 4.1 共用对象 `ctx`

| 成员 | 说明 |
|---|---|
| `ctx.THREE`、`ctx.scene`、`ctx.renderer`、`ctx.post` | three.js 与后期（`post.dof.focus/aper/maxCoc`、`post.bloom.strength/threshold/radius`、`post.vig.uniforms.amt/warm`：每帧都由开头代码重设，章节可在 `update` 里覆盖；**别碰其他后期参数**） |
| `ctx.cam` | 相机对象：**不要直接动**，用 `camera` 关键帧 |
| `ctx.root` / `ctx.layer(id)` | 本章图层（世界坐标；放书页之外的东西：桌面上的城、灯光等） |
| `ctx.book.spread(n)` | 跨页 n：`root`（地面页上的立体件，原点 = 书页中心，y 向上，x 向右，z 朝镜头）、`back`（背板上的挂件：原点 = 背板底边中点，y 沿背板向上，z 朝镜头）、`floor` / `backdrop`（两张面片）、`setFloor(canvas\|texture)`、`setBackdrop(…)`、`window`（[可见起, 可见止] 秒）、`autoFold`（见 §5） |
| `ctx.book.state(t)` / `stackAngle(t)` / `pageAngle(n,t)` / `spreadAt(t)` | 书的角度（度）与当前跨页，纯函数 |
| `ctx.book.setCoverOverlay(from, (x2d, t, S2) => …)` | 封面叠印：t ≥ from 时在封面画布（1920×1080 版面 × S2）上加画（第七章封面字用） |
| `ctx.lamp` | `{ spot, fill, rim, model, head, base, LAMP0 }`：只读；改灯用模块的 `lamp` 序列 |
| `ctx.kit` | 工厂（§7）：`card`、`piece`、`vfold`、`text`、`label`、`paperArt`、`standAt`、`popAt`、`ip`、`tex`、`img`、`placeholderCard` |
| `ctx.ip(key)` / `ctx.tex(key, {repeat})` | 按 `assets.js` 键名加载 IP 图（HTMLImageElement）/ 材质贴图（THREE.Texture） |
| `ctx.opening` | 开头的物件句柄：`stage`（纸舞台组）、`cards[3]`、`stillG`（大闹天宫剧照卡）、`labelG`、`clouds[3]`、`trackG`、`tabG`、`mtn`、`wings`、`band`、`sky`、`hinge`、`spot`… |
| `ctx.publish(k, v)` / `ctx.use(k)` / `ctx.has(k)` | 跨章共享（例：第五章 `publish('city', …)`，第六七章 `use('city')`） |
| `ctx.onReset(fn)` | 改了开头物件上"开头代码不会每帧重设"的属性时，登记一个复位函数（t < 20 s 时调用） |
| `ctx.screenBox(obj)` / `ctx.project(x,y,z)` | 屏幕像素框 / 投影（1920×1080） |
| `ctx.camKey(…)`、`ctx.PG`（书页表面高 .023 m）、`ctx.BW / BD / ZH / PW / PD` | 书宽 .48、深 .28、书脊 z = −.14、书页 .472 × .274 |
| `ctx.TEXT`、`ctx.S` | 文字白名单；开头 stage 对象（`coverToWorld` 等） |

### 4.2 最小示例：在跨页 5 上立一张 IP 卡

```js
let card;
export async function build(ctx) {
  card = ctx.kit.card(await ctx.ip('p04_kedou'), { h: .11 });     // 整张图 + 白边 + 切口，原点 = 底边中点
  card.position.set(-.08, 0, -.02);
  ctx.book.spread(5).root.add(card);
}
export function update(t, ctx) {
  ctx.kit.standAt(card, t, at(33, 1));                            // 向前扣倒 → 在第 33 小节第 1 拍立起（back() 回弹，与开头同一条曲线）
}
```

### 4.3 接管开头的物件（只有第二章需要）

20.000 s 起开头被冻结在最后一帧的状态（剧照卡刚好走完第 9 个齿，停在日轮前）。第二章可以在 `update` 里继续摆它们（开头代码每帧会先把它们的位置/旋转/可见性重设成 20 s 的值，再交给你覆盖）。规则：
- 位置、旋转、`visible`、`scale` 可以直接改。
- 改材质、颜色、贴图等开头不重设的属性，必须 `ctx.onReset(() => 复原)`。
- **不要重画开头纸条标签的画布**（stage.js 按字数缓存）；要新的标签用 `ctx.kit.label(TEXT.ch2.a.title)`。
- 第 14 小节第 1 拍第 1 页翻走，开头纸舞台跟着自动折平并隐藏。

## 5. 书：翻页、摊平、合书（共用层，按 timeline 的 `BOOK` 自动做）

结构沿用开头：封面立起做背板，书页做地面。翻一页 = 地面页绕书脊翻起 90°、贴到背板那一摞上；它的**背面**成了新跨页的背板，下一页成了新地面。

| 动作 | 时刻 | 曲线 |
|---|---|---|
| 翻页 1→2、2→3、3→4、4→5、5→6 | 26 / 38 / 48 / 60 / 96 s 落定 | 落定前 0.75 s 预备抬起 4°；前 0.45 s 主动作（先慢后快），**落定那一帧正好 90°**，回弹 7°→2°→落定（约 0.34 s） |
| 翻页 6→7 + 整摞摊平 | 122 s 落定 | 0.75 s eio，书页与封面落到 175.3°（封面远边刚好碰到桌面），落地回弹 1.2% |
| 合书 | 176 s 落定 | 0.9 s 加速合上（像落下），落定那一帧 0°，回弹 1.5° |

- **立体件自动折平**：书页抬起 0→50° 时，该跨页 `root` 在法线方向压扁到 0（`spread.autoFold = true`，默认）。想自己做"折叠"动画就在 build 里设 `spread.autoFold = false`，自己在 `update` 里处理；翻走后 `root` 自动隐藏。
- 开头的纸舞台（跨页 1）同样自动折平；跨页 7 在合书时随整摞角度折平（第六七章应在第 88 小节先把城收回，见 ch67 占位）。
- 翻页的"唰"、落定纸拍、书脊吱呀，摊平的唰 + 纸板落定，合书的"啪"，都由 `mix.py` 按 `events.json` 自动配，**章节不要重复写**。
- 跨页可见窗口：跨页 n 从上一页开始预备抬起的前一帧可见，到这一页翻走后 0.7 s 隐藏（`spread.window`）。
- 默认书页美术是暖纸 + 朱红双细框（占位）；章节用 `spread.setFloor(canvas)` / `setBackdrop(canvas)` 换掉。画布尺寸建议 `PW×PD` 米 × 5000 像素/米（2360×1370）；地面页画布上沿 = 书脊一侧，背板画布下沿 = 书脊一侧。

## 6. 相机

机位是 7 维 `camKey(fov°, 仰角°, 方位°, 目标 x, y, z, 画面可视高 m)`：相机绕目标点做轨道，距离由"可视高 + fov"算出（改 fov 不改构图 = 推拉变焦）。插值在 log fov、log 可视高空间做单调三次（不过冲）。方位角不要绕 ±180° 跳变。

**衔接约定**
- 每章只在自己的 `range` 里写关键帧；共用层在每个章节边界 b 的 `[b − w0, b + w1]` 窗口里，用两边章节在窗口端点的**机位与速度**做 Hermite 插值——位置和速度都连续，不会有跳变或急停。
- 窗口（`timeline.js` 的 `CAM_BRIDGE`）：20 s 处 `[20.0, 21.0]`（开头锁定，原机位走到 20.000 s 为止，之后 1 s 衔接到你的第一个关键帧的轨迹上）；60 / 96 / 122 / 146 s 处各 `[b − 0.5, b + 0.5]`。
- 所以：**你在边界前后 0.5 s 内写的关键帧不会被看到原样**——边界附近想要什么构图，把关键帧放在窗口外（例如第三章第一个关键帧放在 61.0 s）。想让边界处镜头静止，就让窗口两端的轨迹本身静止。
- 没写任何关键帧的章节用默认镜头（看当前跨页）。
- 第六章"等距"：用准正交 `camKey(≤1°, 35.264, 45, …)`（fov 0.8° 时透视误差 < 1%）；从透视到等距 = 把 fov 从 ~30° 推到 0.8°、可视高不变（推拉变焦，一气呵成）。不需要换正交相机，景深、阴影、后期全部照常工作。
- 景深：默认焦点 = 目标点距离、光圈 7.5；要拉焦点在 `update` 里覆盖 `ctx.post.dof.focus / aper / maxCoc`。
- 规范：每章至少三种运镜；关键时刻主体占画面高 1/3 以上。

## 7. 卡片、纸件、文字、IP 规则

| 工厂 | 用途 |
|---|---|
| `kit.card(img, { h=.108, border=.045 })` | IP 卡：原图整张 + 白边 + 灰纸板切口，受台灯光、投卡片形状的影子；原点 = 底边中点 |
| `kit.piece(canvas, w, h, { border, ax })` | 任意 Canvas2D 画（透明底，5000 像素/米）→ 白边切口纸件 |
| `kit.vfold(canvas, w, h)` | V 形折页：`g.userData.setV(弧度)` |
| `kit.text(str, { sizeM, f:'SC'\|'SCM'\|'InterF', weight, color, align, ls })` | 受光的印刷字面片（XY 平面朝 +z）；`mesh.userData.setChars(n)` 打字机 |
| `kit.label(str, { w, h })` | 开头那种纸条标签：`{ g, set(n) }`，`set(n)` 打出前 n 个字（朱红光标） |
| `kit.paperArt(w, h, { fill, line })` | 平涂纸板底图 |
| `kit.standAt(g, t, tb, d=.62)` / `kit.popAt(t, tb, d)` | 在拍上立起（back() 回弹，第一次到位 = tb 那一帧） |

- **IP 图规则**：整张印成带白边的卡片；卡片可以移动、翻转、受光、被景深虚化；**图本身不改色、不变形（保持原宽高比）、不抠图、不重画、不全屏**；纸纹只能盖在白边上。用 `kit.card` 就满足。
- 文字只能取自 `TEXT`（`src/shared/texts.js`）；字体子集已包含全部白名单字。`tools/cuecheck.py` 逐 0.25 s 核对 `texts()` 报上来的字，清单外报错。**所有画面文字都要在 `texts()` 里报**（包括封面叠印、印在纸上的字）。
- 对拍的"画面时刻"沿用开头 TREATMENT §0-11：落定类（立起、落位、打字）= 第一次到位那一帧；起动类（拉片、灯、开始移动）= 第一帧开始变化。

## 8. 台灯

模块导出 `lamp = [{ t, dur = .18, dim?, yaw?, aim?, color?, env?, sound? }]`：从 t 起 dur 秒内（eio）移到给定值，没给的属性保持。各章序列合并成一条（按时刻排序），**不要让两个转场重叠**。

| 属性 | 默认 | 说明 |
|---|---|---|
| `dim` | 1 | 亮度倍数（主光、补光、灯泡自发光一起变；房间环境光默认跟着 `0.35 + 0.65·dim`） |
| `yaw` | 0 | 整盏灯绕灯座转向（度，正 = 从上看逆时针）；灯头位置跟着转 |
| `aim` | `[.02, .063, −.03]` | 光斑对准的世界坐标 |
| `color` | `#ffe2bd` | 灯光颜色 |
| `env` | 跟随 dim | 房间环境光倍数（单独压暗/提亮） |
| `sound` | true | false = 不自动配声 |

`dim` 变化自动配"开关咔 + 电流变化"，`yaw` 变化自动配关节摩擦；灯管嗡声音量全片跟着 dim 走（`mix.py` 读 `events.json` 里的亮度曲线）。现有占位：第 20 小节第 2 拍调暗到 0.3、第 25 小节恢复（ch2）；116 s 转向 14°（ch4）；第 61 小节第 4 拍转回（ch5）。冷月光等额外光源由章节自己在 `ctx.root` 里加（图层隐藏时灯也关）。

## 9. 声音

### 9.1 分层

```
0–20 s   开头原混音（kaitou_mix.py，锁定）
20–180 s music.wav（作曲）× 侧链闪避
       + 共用拟音（翻页 / 摊平 / 合书 / 台灯，自动）
       + sfx/ch2.json … ch67.json（各章）
       + 房间环境（底噪、随台灯亮度的灯管嗡声、极轻钟表）
→ 尾段增益解到全片 −14 LUFS，真峰值限幅 ≤ −1.2 dBTP → out/mix.wav
```

### 9.2 sfx 清单格式 `sfx/<章>.json`

```json
{
  "chap": "ch3",
  "events": [
    { "ev": "ch3.notch.ink", "type": "detent", "pitch": 1.0 },
    { "bar": 41, "beat": 1, "s16": 2, "type": "scissors", "gain": -3, "pan": 0.4 },
    { "t": 80.75, "type": "scissors", "open": true },
    { "ev": "ch3.ph", "offset": 0.25, "type": "pop", "pitch": 1.4, "duck": -3, "name": "card2" }
  ]
}
```

| 字段 | 说明 |
|---|---|
| 时刻（三选一） | `"ev"`：引用本章 `events()` 的 id（推荐：画面改了声音自动跟）＋可选 `"offset"` 秒；`"bar"/"beat"/"s16"`；`"t"`：秒 |
| `"type"` | 音效类型（下表） |
| `"gain"` | dB，在该类型已校准的电平上加减（默认 0） |
| `"pan"` | −1（左）… 1（右），默认 0 |
| `"duck"` | 额外的配乐闪避深度（dB，负数）；类型自带一个默认值 |
| `"raw": true` | 不量化到整帧（默认量化：时刻四舍五入到最近一帧） |
| `"name"` | 自检报告里显示的名字 |
| 其余键 | 原样作为参数传给音效函数（如 `pitch`、`dur`、`n`、`note`） |

规则：时刻 < 20 s 的条目会被丢弃并报错；落点对准方式由类型决定（onset = 起音对准；end = "止于落点"的声音结尾对准；mark = 声音内部的那一下对准）。`$LIB/.venv/bin/python sfx_kit.py` 列出全部类型，`… sfx_kit.py demo out/sfx_demo.wav` 每种响一次试听。

### 9.3 可用类型（`sfx_kit.py`）

| 类型 | 对准 | 声音 | 参数 |
|---|---|---|---|
| `swish` | end | 纸的"唰"（翻页、翻起） | `dur` |
| `page_land` | onset | 书页拍到书页堆上 | `v` |
| `board` | onset | 硬纸板落定"嘭" | `v` |
| `creak` | onset | 书脊 / 纸铰链吱呀 | `dur` |
| `pop` | onset | 立体书"啵"（折页、卡片立起） | `pitch` 0.8–2 |
| `tick` | onset | 短"嗒" | `pitch` |
| `type` | onset | 打字"嗒" | `i`（字序号） |
| `paper_tap` | onset | 纸边落定"嗒"（满编里穿得出来） | `k` 0/1/2 |
| `slide` | end | 纸片滑出"嘘" | `dur` |
| `shuffle` | end | 纸面平推"沙" | `dur` |
| `flap` | onset | 纸张 / 文件夹翻开"扑" | `size` |
| `cascade` | onset | 纸板层层弹开的连击（城市生长、纸塔） | `n`、`dur`、`pitch` |
| `door` | onset | 门轴纸响 | `dur` |
| `book_close` | onset | 合书"啪"（共用层已自动加） | `v` |
| `rasp` | onset | 拉片木头摩擦 | `dur` |
| `detent` | onset | 拉片到档木卡扣 | `pitch` |
| `ratchet` | onset | 纸轨齿 / 棘轮 | `pitch` |
| `turntable` | mark | 纸转盘转 90°，最后一下棘轮对准 | `dur` |
| `press` | onset | 铅字落纸 | `size` 0–4 |
| `stamp` | onset | 橡皮章"嘭" | `pitch` |
| `stamp_ink` | onset | 等距印字橡皮章（更重 + 印泥粘离） | `pitch` |
| `scissors` | onset | 剪刀"咔嚓"（`open: true` = 张开的轻"嚓"） | `v`、`open` |
| `step` | onset | 纸人小脚步 | `pitch` |
| `switch` | onset | 台灯开关"咔哒" | — |
| `current` | onset | 电流变化（嗡声 frm→to + 噼啪） | `frm`、`to`、`dur` |
| `lamp_switch` | onset | 开关 + 电流（共用层已自动加） | `frm`、`to` |
| `swivel` | onset | 台灯转向关节（共用层已自动加） | `dur` |
| `spot` | onset | 追光灯"咣" | `v` |
| `brush` | end | 毛笔擦纸沙沙（水墨） | `dur` |
| `sand` | onset | 矿物颜料研磨细沙（壁画） | `dur` |
| `felt` | onset | 毛毡 / 布幕闷"噗" | `v` |
| `burst` | onset | 暖光迸开"轰"（燃比娃） | `dur` |
| `whoosh` | onset | 空气"呼" | `dur` |
| `chime` / `woodblock` / `gong` / `pipa` | onset | 带音高的点缀（采样 / 拨弦；E 羽五声 E G A B D，和作曲协调） | `note` / `var` |

需要新类型：在章节文件顶部写"需求：sfx 类型 xxx（声音描述）"，由架构加进 `sfx_kit.py`。

### 9.4 作曲约定（`music.py`）

- 输出 `out/music.wav`：48 kHz、立体声、180.000 s、浮点、不做响度处理（mix.py 统一做）。20 s 之前的内容会被清零。
- 开头最后一拍是军鼓滚奏 + 唢呐停在属音 B5 不收：**第 11 小节第 1 拍（20.000 s）要有一个接住它的强拍**。0–20 s 的开头配乐在 `C-kaitou/mix.py`（= `kaitou_mix.py`）里，主题、调式（E 羽五声）、配器从那里接。
- 结构见规范 §4.1：静默拍 115.5–116.0 s 全部乐器停（侧链不会帮你停）；116.0 s 最强；176.0 s 合书"啪"（拟音自动加）主音收住，余音约 2 s 到片尾。
- 侧链：所有音效会自动压住配乐（总线 3:1，最多 −8 dB；带 `duck` 的音效再额外让开），不用在 music.py 里给音效让位。
- 节拍网格与章节时刻读 `events.json`（`page_turn` 的 t、`ch4.silence` 等），不要自己猜。

### 9.5 混音细节（mix.py，架构维护）

- 开头：`kaitou_mix.py` 输出与 C-kaitou 逐采样相同，再用与 `$LIB/core/render/mux.sh` 完全相同的两遍 loudnorm 处理（有缓存）；mix.wav 存 32 位浮点、封装时不再 loudnorm——成片 0–19.95 s 的 AAC 音轨与原片逐位相同。
- 20.000 s 处：开头混音按原样在最后 10 ms 淡出（"被剪断"），20 s 起的配乐和环境声接上（环境 10 ms 淡入）。
- 尾段整体增益用割线法解到全片 −14 LUFS（±0.2），真峰值前瞻限幅（4× 过采样）到 −2.2 dBTP（给 AAC 留余量）；报告在 `out/mix_report.json`。
- 每条音效的计划时刻与实测落点写 `out/cues.json`（cuecheck 用）。

## 10. 分段渲染与自检

| 命令（在工程目录或任意目录） | 作用 |
|---|---|
| `sh tools/seg.sh ch3` | 只渲染第三章区间：`out/seg/ch3.mp4`（画面 + 从全片混音切出的声音）+ `out/seg/ch3_sheet.jpg`（每 0.5 s 一格，格名 = 全片时间） |
| `sh tools/seg.sh ch3.paper` / `sh tools/seg.sh 78:84` | 小段 / 任意秒区间 |
| `SIZE=960x540 SS=1 sh tools/seg.sh ch3` | 低成本预览（约 4 倍快） |
| `sh tools/still.sh 64.5 72 80.25` | 单帧 → `out/stills/t_<t>.jpg`（全片时间；可加 `--q ss=1`） |
| `cd $LIB && node core/render/video.mjs <工程> --fps 30 --workers 2 --q 'seg=ch3' --out …` | seg.sh 的画面部分（`?seg=` 参数：`ch3` / `ch3.ink` / `60:96`） |
| `$LIB/.venv/bin/python mix.py` | 全片混音（10–20 s） |
| `node tools/probe_full.mjs && $LIB/.venv/bin/python tools/cuecheck.py [C-quanpian.mp4]` | 全片自检：时长、翻页落帧、每条音效音画差、sfx:true 事件有没有声音、画面文字白名单 |
| `$LIB/.venv/bin/python tools/kaitoucheck.py` | 开头不变性：5 帧 SSIM ≥ 0.98 + 声音逐采样 |
| `sh build.sh` | 整片：events → mix → 渲染（3 worker）→ 封装 → 海报 → 自检 |
| `SIZE=960x540 SS=1 sh build.sh` | 整片低成本管线验证（输出 `out/C-quanpian_preview.mp4`） |

- 渲染命令都在 `$LIB=@@LEMO_ROOT@@` 下执行（脚本已处理）；`RENDER_SLOTS=4`；分章 `--workers 2`（seg.sh 默认），整片 `--workers 3`。超过 2 分钟的命令后台运行。
- 几个人同时跑 seg.sh 互不干扰：每段的事件表、混音、视频都写在 `out/seg/<段>_*`；开头混音缓存与 music.wav 是原子写。
- 速度参考（本机，1920×1080，2× 超采样）：每个 worker 约 15 帧/秒（占位场景；内容多了会变慢），整片约 2–3 分钟。

**交稿前自查（每章）**：`seg.sh` 看联系表；`cuecheck.py` 本章 0 错误、0 PLACEHOLDER；本章文字全部来自 `TEXT`；IP 卡全部用 `kit.card`；边界前后 0.5 s 的镜头看过；在本章窗口之外没有本章的东西露出来（看相邻两章的联系表）。

## 11. 已知限制与约定

1. **开头锁定的代价**：20.000 s 开头物件冻结在最后一帧；第一章原来的镜头轨道在 20.2 s 有一个关键帧，衔接窗口 20–21 s 用的是它在 20 s 的速度。开头的声音在 19.99–20.00 s 有原混音自带的 10 ms 淡出（被"剪断"），需要作曲在 20.000 s 放强拍接住。
2. **AAC 边界**：成片 19.95–20.0 s 的 AAC 帧与原片不同（编码窗口跨过 20 s），所以 kaitoucheck 只比到 19.9 s。
3. **书页叠放**：翻过去的书页沿法线每页错开 0.8 mm，6 页共约 5 mm；摊平后封面远边落桌，书脊附近有书块厚度（PG = 23 mm）的台阶。第五章做"纸面向四周延展"时，延展面的高度要接上书页（y ≈ .023），桌面上的部分自己做斜坡或纸板台阶。
4. **准正交**：fov 0.8° 时相机距离约 36 m（可视高 .5 m），近裁剪面 = 距离 × 0.2；不要把物体放在离目标点 > 5 m 的地方。HDRI 背景在等距镜头里仍是近黑。
5. **立体件自动折平是"法线方向压扁"**，不是真的折叠；镜头正对翻起的书页时看不见，侧面大特写会看出来——要特写就关掉 autoFold 自己折。
6. **跨页 7 被第五、六、七章共用**：城市归第五章（`publish('city', { group, retract })`），第六七章在自己的 `update` 里覆盖 `retract`、收城；「谈」字街道需要两章协商城市平面（建议第五章把「谈」字笔画留成街道，并在 publish 里给出街道布局）。
7. **封面字**：合书后的封面仍是开头的瑞士海报版面，第七章用 `setCoverOverlay` 在其上叠印「选定方向 · 开始洽谈」；占位只是一条纸带。
8. **占位**：五个章节模块、五份 sfx 清单、music.py 都是占位；占位卡上的字（`PLACEHOLDER`）不在白名单里，cuecheck 记 WARN，成片前必须为 0。占位节拍器很稀疏，全片响度靠尾段 +24 dB 增益才到 −14 LUFS——换成真配乐后增益会回到 0 附近。
9. **海报** `poster.jpg` 暂取 116.5 s（全片最强的一下之后），合成阶段再定。
10. 开头的几何调参脚本（labeltune 等）留在 `C-kaitou/tools/`，本工程不再带。

## 12. 骨架验收记录（2026-11-02，占位版整片）

| 项 | 结果 |
|---|---|
| 整片 | `sh build.sh`：5400 帧 1920×1080 渲染 120 s（3 worker）；视频 5400 帧 / 180.000 s，音频 180.000 s |
| 翻页落帧 | 26 / 38 / 48 / 60 / 96 / 122 s 翻页、176 s 合书：probe 里到位帧 = 计划帧（780、1140、1440、1800、2880、3660、5280） |
| 音效 | 44 条（共用 24 + 各章 20），每条实测落点与计划差 0.00 ms；sfx: true 的事件全部有声音 |
| 响度 | 成片 −14.1 LUFS，真峰值 −1.2 dBTP |
| 开头不变 | 五帧 SSIM：0.5 s 1.0000 · 5 s 0.9999 · 10 s 0.9882 · 15 s 0.9914 · 19.9 s 0.9825（全部 ≥ 0.98）。同一时刻新旧工程直接出的静帧逐像素相同（最大差 0），SSIM 的差距只来自 x264 在 180 s 与 20 s 两种片长下的码率分配不同。声音 0–19.9 s 解码后逐采样相同（最大差 0） |
| 文字 | 721 个采样点全部在白名单内；占位卡文字 8 条（PLACEHOLDER 警告，预期） |
| 分段 | `SIZE=960x540 SS=1 sh tools/seg.sh ch2`：40.000 s、1200 帧、联系表 80 格，约 1 分钟 |

## 13. 合成记录（2026-11-02，成片）

**共用层改动**
- `world.js`：第 n 页的 `backRoot` 只在 `spreadWindow(n+1)` 内可见，封面背板挂件只在跨页 1 窗口内可见，t < 20 s 时全部隐藏。这是 ch4 / ch5 的需求。第五章 update() 里原来的兜底代码保留，叠加后没有副作用。
- `world.js`：轮廓光 `rim.intensity *= min(1, dim/0.25)`，只在熄灯时生效。这是 ch4 的需求，2c 和木偶段不受影响。
- `main.js`：开头标签的 `TEXTS` 上报截止时间改为 `KEY.ch2.label + 0.36`（20.86 s）。这是 ch2 的需求。
- `mix.py`：限幅天花板从 −2.2 改为 −3.0 dBTP，因为实测 AAC 过冲 1.3 dB；全静拍里环境层只留 35% 底噪、不走钟表。
- `tools/cuecheck.py`：修正 ffprobe 返回 `5400,` 时的解析。新增 `tools/gen_sfx_ch3.mjs`，即第三章 sfx 导出脚本，从临时目录收进工程，输出与现有清单逐字节相同。
- `build.sh`：海报改为取 179.5 s 的结尾封面。
- 台灯转场全片不重叠：38.5–38.8、48.0–48.25、89.5–89.8、95.0–95.4、115.47–115.57、115.97–116.03、116.6–118.0、121.5–122.0，以及三次只改 aim 的无声微调 124.0–125.5、135.0–136.5、137.0–137.9。

**成片实测**（`C-quanpian.mp4`）
| 项 | 结果 |
|---|---|
| 规格 | 1920×1080，30 fps，视频 5400 帧 / 180.000 s，音频 180.000 s，容器 180.000 s |
| 响度 | −14.1 LUFS，LRA 8.5 LU，真峰值 −1.2 dBTP（开头原母带 −1.2，尾段 ≤ −1.4） |
| 卡点 | cuecheck 0 错误、0 警告：翻页 / 摊平 / 合书的到位帧 = 计划帧；389 条音效（共用 27、ch2 51、ch3 112、ch4 29、ch5 62、ch67 108）最大音画差 0.00 ms；sfx: true 的事件都有声音；AAC 解码后和 mix.wav 的偏移是 0 个采样 |
| 文字 | 721 个采样点全部在白名单内；源码里不在白名单的中文串只有文件名、报错信息、笔画名，都不画到画面上；没有 LemoLab / Opus 字样（库路径除外） |
| 黑场 / 冻结 | blackdetect（0.1 s，像素阈值 0.05）、freezedetect（1 s）都没有检出。115.5 s 那一拍画面均值约 8/255，有窗灯，按设计不是纯黑帧 |
| 开头不变 | kaitoucheck 通过：五帧 SSIM 1.0000 / 0.9999 / 0.9882 / 0.9914 / 0.9825，声音 0–19.9 s 逐采样相同 |
| readcheck（`--step 0.1`，只算第一次连续完整入画的时长） | 57 段 OK、14 段 BAD。原因分三类：① 开头标签 12.3 s（锁定，不动）；② 文字框是整块牌子 / 纸条的三维包围盒，牌子底边出画几像素就记为"没完整入画"，看画面字本身是完整的（「担当」「守护」「友情」「生活」「中国奇谭」「应用示意，共创形式」和两条案例纸条）；③ 时间确实不够：「已公开的合作案例」打完后完整可读约 0.6 s（连打字约 1.6 s，之后镜头俯冲过去），口径小字 43 个字只有 2.2 s（规范规定放在最后一小节） |

## 14. 返修记录（2026-11-02，审片 7.3 → 返修一轮）

逐条改法与理由见 `TREATMENT.md` §5。共用层只改了一处：`timeline.js` 新增 `BOOK.FLAT_SWING = .5`，`world.js` 摊平时第 6 页 121.25–121.5 只预备抬 4°、121.5 起 0.5 s 翻过（整摞背板仍按 `FLAT_D` 0.75 s），`book_flat` 事件的 `swing` 改为 0.5（摊平的"唰"从 121.4 起）。章节改动：ch2（2d 转盘）、ch3（木偶推近机位）、ch4（自收折、牌子时刻、换字、窗门、折扇）、ch5（纸条最上层、檐口、书店停留与甩镜、三道门 138.5/139/139.5、门楼 retract 分段）、ch67（门楼 144.5–145.5、地毯式地板、广场小物缩回、跟随段机位、口径小字）。

**成片实测**（`sh build.sh`，渲染 125 s，整条 3 分 17 秒）
| 项 | 结果 |
|---|---|
| 规格 | h264 1920×1080 30 fps 5400 帧 180.000 s；AAC 48 kHz 立体声 180.000 s |
| 响度 | −14.1 LUFS，LRA 8.5 LU，真峰值 −1.2 dBTP；逐样本峰值 L −1.54 / R −1.59 dBFS |
| 卡点 | cuecheck ok 25 / warn 0 / err 0；音效 386 条（book 27、ch2 42、ch3 112、ch4 32、ch5 62、ch67 111）；翻页/摊平/合书到位帧 = 计划帧 |
| 独立起音（10 ms 能量通量，35 个点） | 全部在网格 ±0.1 s 内：50/52/54/56（转盘）、99.0（牌子）、104–106（窗）、121.0（收折起）、122、125.5、138.5/139/139.5（门）、144.5（关门）、146、176 等多为 0 ms |
| 静拍 / 最强拍 | 115.55–115.94 RMS −42.8、峰值 −33.0 dBFS；最响 400 ms 窗口 116.1 s（−7.6 dBFS RMS） |
| 黑场 / 冻结 | blackdetect(0.2 s)、freezedetect(−60 dB, 1 s) 均 0 检出 |
| 开头不变 | kaitoucheck PASS（SSIM 1.0000/0.9999/0.9882/0.9914/0.9825，声音 0–19.9 s 逐采样相同） |
| 文字 | 721 个采样点全部在白名单内 |
