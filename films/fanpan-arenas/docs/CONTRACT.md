# 《一步翻盘》自定义擂台：接口与质量约定（给做场景的人看）

> 制作时发给每个场景制作者的约定原文，留作过程记录。本机路径换成了占位写法；接口以游戏仓库 `arenas/README.md`（这里的 [../arenas/README.md](../arenas/README.md) 是同一份）为准。

游戏在 `<游戏仓库>`（《一步翻盘》的本地克隆；three r180，无构建步骤，浏览器直接跑 ES 模块）。
你只写自己的文件夹 `arenas/<文件夹>/`，入口是 `arena.js`。**不要改这个文件夹以外的任何文件**（`board3d.js` 的接口已经接好，别动），**不要 git 提交 / 推送 / 发布**。

## 入口

```js
export function build(ctx) { …; return { tick(t, dt) {} }; }
```
`build` 只调一次。`tick(t, dt)`：t 是场景自己的钟（秒），每帧调一次；**「减少动态效果」（`ctx.calm`）时游戏不调 tick**，所以 build 结尾要自己 `scene.updateMatrixWorld(true); tick(0)`，并在 `resize` 后补摆一次（镜头是 build 之后才摆好的：`requestAnimationFrame(() => tick(last))`，再 `setTimeout` 400ms 补一次）。

`ctx = { THREE, scene, camera, renderer, amb, sun, tiles, lines, castles: [ownGroup, foeGroup], post: { bloom, tiltH, tiltV, grade }, low, calm, team: [0x00c098, 0xf84850], grid: { ROWS, COLS, LX, LZ, HALF, DEPTH, HPY, SHORT, tileX, tileZ } }`

- 只能 `import` 自己文件夹里的文件；three 用 `ctx.THREE`（不要自己 import three）。**没有外部图片、字体、网络请求**：所有贴图都用 canvas 逐像素算出来（`CanvasTexture`，`NearestFilter`，不要 mipmap，`SRGBColorSpace`），每米 48 像素左右，和棋子的像素密度一致。
- 不从 `arenas/` 下别的文件夹 import，也不照抄它们的画法代码和贴图；可以读 `arenas/c-zhai/arena.js`、`arenas/b-shui/arena.js` 学接口怎么用、质量到什么程度。你的场景要有自己的一套画法文件（比如一个调色 / 浮雕着色的小库 + 贴图 + 小件）。

## 坐标与棋盘（不能改的东西）

- x 向右（本方 → 对面），z 朝镜头，y 向上。`ROWS = 5` 沿 x，`COLS = 4` 条路沿 z。`tileX(r) = (r - 2) * LX`（第 0 行贴着本方城堡，在左），`tileZ(c) = (c - 1.5) * LZ`（第 0 路最远，第 3 路最靠镜头）。`HALF = ROWS*LX/2`，`DEPTH = COLS*LZ`。桌面 `LX = 1, LZ = 1.2, HPY = 2.2`；手机横屏（`SHORT`）`LX = 1.5, LZ = 1.4, HPY = 1.75`。**一律用 grid 里的数，不要写死。**
- 格子：`tiles` 是游戏自己的 20 块 `BoxGeometry(LX-.03, .06, LZ-.05)`，顶面在 y = .06，`userData = { c, r, base }`；点击、悬停、抬起动画都靠它们，**不能移动、隐藏、替换几何体**，只能换材质：`t.material = new THREE.MeshLambertMaterial({ map })`。顶面 UV 是 0..1；四个侧面全都采样贴图**左上角那颗像素**，所以每张格子贴图的左上角要是你想要的侧边颜色（一般是深色勾缝）。做法：画一张整盘的贴图，按 `(r, c)` 切成 20 小张。本方出兵列（r = 0）偏青、对面出兵列（r = 4）偏红，中间中性；格子之间的缝要看得清。
- 棋子是游戏画的：**不吃光的像素立牌**（`MeshBasicMaterial`，永远是贴图原色），脚下有队伍色的圈和战力数字。游戏还会在盘面上画前线（青 / 红的竖线）、可放格子的高亮、箭头、特效。所以**盘面本身要比棋子暗、比棋子素**：盘面平均亮度压在 0.15–0.3，不要在格子上放抢眼的亮色图案或会动的东西；最亮、最花的东西放在盘外。
- 城堡：`castles[0]`（本方，在 x = -(HALF+1.3)）和 `castles[1]`（对面，x = +(HALF+1.3)）是两个空的 `Group`（原点 y = 0，即盘面底），挨打时整组左右抖、被攻破时整组往下沉 0.5 并抖。**把你的两座「门 / 祠 / 塔」搭进这两个组里**（用组内坐标），它们就会跟着动。组里已经有一个血量牌 Sprite（`(0, HPY, .2)`，不参与深度测试，永远画在最上面）：**血量牌周围不要放很亮或很花的东西**，要读得清。城堡沿 z 要盖住四条路（约 DEPTH 那么深），宽约 2，高不要超过 3.2（再高会出画）。本方用青色系（`team[0]`）、对面用红色系（`team[1]`）点题，但造型按你的主题来，两座不要只是换色。
- 镜头是游戏的：FOV 22°，俯角 25°–30°，看向 `(0, .95, -.1)`，距离随窗口变，带 ±0.3 的左右微移。取景保证这三个点进画面：最高点 `(0, 3.2, -DEPTH/2 + .35)`、盘面最前沿、血量牌。所以：后景（z < -DEPTH/2）可以堆高到 4–6 米（越往后越可以高，会被移轴虚掉）；z > DEPTH/2 + 1.5 的前景在画面最下面，**屏幕底部约 19% 被手牌盖住，右上角有一块对局记录面板**，这些地方不要放关键内容。手机横屏时画面更扁，盘面占满，只看得到盘外一小圈。
- 要贴着镜头的前景遮挡（叶子、帘子、栏杆剪影）时，每帧用 `vec.set(nx, ny, .5).unproject(camera)` 按画面坐标定位（只压在画面四角 / 上沿），不要写死世界坐标。

## 光与后期（都是游戏已有的对象，直接改）

- 渲染器 `NoToneMapping`：颜色超过 1 直接截断。`renderer.shadowMap` 是 `PCFSoftShadowMap`。
- `amb`（AmbientLight）、`sun`（DirectionalLight，`castShadow`）：改颜色 / 强度 / 位置。阴影：`sun.shadow.mapSize.setScalar(low ? 2048 : 4096); if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }`，`Object.assign(sun.shadow.camera, { left: -16, right: 16, top: 16, bottom: -16, near: 2, far: 64 }); sun.shadow.camera.updateProjectionMatrix(); sun.shadow.bias = -.0006; sun.shadow.normalBias = .03;`。可以自己加补光和点光（点光控制在 8 盏以内，`low` 时更少）。
- 想要「光从窗 / 树冠 / 栅格漏下来」：放一片 `colorWrite: false, depthWrite: false` 且 `castShadow = true` 的镂空板在太阳和场地之间（漏光板），盘面上方留一整块亮的。
- `scene.background`（Color）和 `scene.fog` 你来定。
- 后期只在高画质档有（`low` 时没有后期，也没有泛光）：
  - `post.bloom`（UnrealBloomPass）：`strength / radius / threshold`。不吃光的材质把颜色乘到 > 1 才会晕开（low 档没有泛光，这时别超过 1.15）。
  - `post.tiltH / tiltV`（移轴）：`uniforms.focus`（清楚带的中心，画面高度 0..1，从下往上）、`band`（清楚带半宽）、`amt`（虚化强度）。参考图的清楚带在棋盘上，下面约 1/3 和最上面是虚的。
  - `post.grade`（调色，默认关）：`uniforms.sat, con, knee`（数）和 `gain, lift, edge`（Color：整体增益、暗部抬色、四角加色），设完 `post.grade.enabled = true`。
- 游戏在所有后期之后还有一层暗角。

## 画面目标（用户的要求，原话的意思）

用户要「HD-2D」式的画面：像素贴图的 3D 微缩场景 + 移轴景深 + 强烈的光影和泛光。原话要点：**场景要精细、小组件细节多、场景丰富度高、多用特效、颜色饱和度高，但棋子必须显眼**；逐像素地画，不要大色块；景深和光影方案要像参考图那样明确。量过参考图的数：清楚带在画面高度 25–55%，底部从约 65% 往下虚；平均亮度 0.13–0.23，最亮 5% 在 0.43–0.59 以上，饱和度 0.48–0.72，四角亮度是中心的 0.21–0.34。

质量底线（对照 `<截图目录>/c/desktop-high.png` 和 `b/desktop-high.png`，要达到同一水平）：
1. 画面里没有空的大色块：盘外每一块都有贴图细节和小件（几十种小件、几百个摆放）。
2. 至少 8 种会动的东西（火、水、布、烟、粒子、光的明灭、机械……按主题定），像素类的动画按每秒 8 拍跳帧，光和飘的东西连续走。
3. 有明确的主光方向、暖冷对比、投影，和至少两种颜色的发光体；高画质档有泛光。
4. 三层景深：贴镜头的前景（虚）、棋盘和两座城堡（清楚）、后景（往后越来越虚、越来越暗或越来越淡）。
5. 两座城堡一眼能分清敌我，血量牌清楚。
6. 棋子在盘上是最醒目的东西。
7. 你的主题、配色、组件和别的场景不重样（见任务书里的清单）。

## 性能与健壮

- 合批：实体按材质拼成少数几张网格，小件拼一张图集、按层合成几张网格；会动的小件预留缓冲每帧重写。目标：绘制调用 < 400，三角形 < 3 万，`low` 时粒子和点光减半。
- 不要每帧 new 对象、不要每帧建贴图。
- `build` 里抛错会让游戏退回默认场地并在控制台报「自定义擂台没载入」：这算没做完。

## 自检工具（必须用，做完之前至少看 6 次图）

游戏服务已经在 `http://localhost:8770` 跑着（不要自己再起、不要停它）。无头浏览器开一局、自动走子、截图（在北冥仓库根目录跑；`<截图目录>` 就是 `films/fanpan-arenas/out/shots/`）：

```sh
node films/fanpan-arenas/tools/shot.mjs <名字>            # 桌面 1280×720 高画质，产物 films/fanpan-arenas/out/shots/<名字>/desktop-high.png
node films/fanpan-arenas/tools/shot.mjs <名字> --mobile   # 手机横屏 844×390
node films/fanpan-arenas/tools/shot.mjs <名字> --low      # 低画质档（没有后期）
node films/fanpan-arenas/tools/shot.mjs <名字> --calm     # 减少动态效果（不调 tick）
node films/fanpan-arenas/tools/shot.mjs <名字> --full     # 打到分出胜负（城堡挨打、攻破）
node films/fanpan-arenas/tools/shot.mjs <名字> --turns 12 --tag later   # 多走几回合、另存一张
```
它会打印 `stats`（`theme` 必须是 `arena-<名字>`，否则就是你的模块没载入）和控制台报错；退出码非 0 说明有报错或没载入。**用 Read 工具看截图**，对照质量底线自己挑毛病、改、再截，直到满意。写完先 `node --check` 每个文件。

## 交回的内容

- 你写了哪些文件、各管什么。
- 最后一轮五条命令（桌面、mobile、low、calm、full）的结果：stats 和有没有报错。
- 你自己看图后认为还不够好的地方（如实写，不要说全都好）。
