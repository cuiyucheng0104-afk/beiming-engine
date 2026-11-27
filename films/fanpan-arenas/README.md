# 对战盘七景（北冥代码动画风格 · 86 式）

《一步翻盘》对战盘的七套场景，和它们制作过程里用到的全部工程文件：场景源码、让场景脱离游戏也能出图的替身棋盘、发给场景制作者的约定和任务书、验图和拼总览图的脚本、接进游戏的那段改动。

七套场景本身是给游戏用的（游戏仓库 `arenas/`，地址带 `?arena=<名字>` 时启用）。这里的 `arenas/` 是同一份源码的副本，取自游戏仓库分支 `feat/arenas-hd2d` 的提交 `b71ea4d`。

状态：七套都只出了静帧，look、animatic、final 三道闸都没有用户认可；还没有人在游戏里实际玩过一轮来提意见。

## 七套场景

| 镜头 | 名字 | 场景 | 文件夹 | 行数 | 谁做的 |
|---|---|---|---|---|---|
| S1 | `c` | 林间寨擂 | `arenas/c-zhai/` | 795 | 主会话。把 [fanpan-c](../fanpan-c/README.md) 那一版搬进游戏的渲染器重写 |
| S2 | `b` | 沉水擂台 | `arenas/b-shui/` | 893 | 主会话。把 [fanpan-b](../fanpan-b/README.md) 那一版的场面用 three.js 重写（不含原生运行时的任何东西） |
| S3 | `harvest` | 丰收麦场 | `arenas/mai-chang/` | 1214 | 子代理搭建，主会话复查修整 |
| S4 | `sea` | 珊瑚龙宫 | `arenas/shan-gong/` | 1123 | 子代理搭建，主会话复查修整 |
| S5 | `forge` | 齿轮熔炉 | `arenas/lu-fang/` | 1122 | 子代理搭建（中断过一次，续做），主会话复查修整 |
| S6 | `sky` | 云上浮岛 | `arenas/yun-dao/` | 1143 | 子代理搭建（中断过一次，续做），主会话复查修整 |
| S7 | `chapel` | 彩窗圣堂 | `arenas/sheng-tang/` | 1493 | 子代理搭建，返工一轮（城堡加体量、整体压暗、补地面细节），主会话复查修整 |

「主会话」「子代理」都是 Claude Fable 5.2。全部用代码逐像素画贴图、拼合批网格，没有外部图片，没有 AI 生成的画面。每个文件夹各用各的画法和贴图，文件夹之间互不引用。接口和每套独有的东西见 [arenas/README.md](arenas/README.md)（游戏仓库里的同一份）。

## 文件

| 文件 | 管什么 |
|---|---|
| `arenas/` | 七套场景的源码（31 个脚本，7783 行），入口都是 `arena.js` 的 `build(ctx)` |
| `stage.js` | 替身棋盘：按游戏 `board3d.js` 的数把格子、前线、城堡的空组、光、镜头、后期链搭一遍，再把场景装上去。没有规则和界面，十个棋子是摆好的 |
| `main.js`、`index.html` | 页面入口。时间只读 `film.json`：七个镜头各出一套场景 |
| `film.json` | 作品描述：7 个镜头 × 96 帧（24 fps，1920×1080，共 28 秒），署名 |
| `units/` | 十条棋子待机序列帧（CC0，来自游戏仓库 `assets/units`，敌方已左右翻转；和 fanpan-c 用的是同一批） |
| `docs/CONTRACT.md` | 发给每个场景制作者的约定原文：接口、坐标、不能动的东西、质量底线、自检办法 |
| `docs/BRIEFS.md` | 五套新场景的任务书原文，和中途追加的四条消息（续做、返工） |
| `docs/board3d-hook.diff` | 游戏 `board3d.js` 为了载入这些场景改的那一段（+20 / −6），只作记录，不在这里生效 |
| `tools/shot.mjs` | 在真游戏里验场景：无头浏览器开一局、自动走子、截图，打印绘制调用数和控制台报错 |
| `tools/sheet.sh` | 把几套场景的截图拼成一张总览，每格左上角标场景名、谁做的、怎么做的 |

## 出图

在仓库根目录。不带参数时按镜头表走，一个镜头一套场景：

```sh
node engine/render/still.mjs films/fanpan-arenas --frame 48,144,240,336,432,528,624 --size 1920x1080 --out films/fanpan-arenas/out/stills
```

只看某一套（整段都出这一套，名字见上表）：

```sh
node engine/render/still.mjs films/fanpan-arenas 0 2 --query arena=forge --size 1920x1080 --out films/fanpan-arenas/out/forge
```

替身棋盘只出桌面版式、高画质档。手机横屏、低画质档、减少动态效果、城堡挨打和被攻破，都要在真游戏里看：先在游戏仓库里起它自带的本地服务（`python3 tools/serve.py 8770`），再

```sh
node films/fanpan-arenas/tools/shot.mjs harvest            # 桌面 1280×720 高画质
node films/fanpan-arenas/tools/shot.mjs harvest --mobile   # 手机横屏 844×390
node films/fanpan-arenas/tools/shot.mjs harvest --low      # 低画质档
node films/fanpan-arenas/tools/shot.mjs harvest --calm     # 减少动态效果
node films/fanpan-arenas/tools/shot.mjs harvest --full     # 打到分出胜负
```

截图在 `films/fanpan-arenas/out/shots/<名字>/`。

## 这里和游戏里的差别

- three.js 这里是 r170（仓库锁定的版本），游戏是 r180。七套场景在 r170 下都能载入、出图没有报错；没有逐像素和游戏对过。
- 游戏每帧给镜头加一点左右微移，这里镜头不动。
- 场景的钟从第 10 秒起算（每个镜头出的是各自第 10–14 秒），慢的循环不会都停在起点。
- 血量牌和战力牌是替身棋盘自己画的点阵数字，不是游戏的字。
- 游戏的界面（手牌、对局记录面板、结算面板）这里没有；取景仍然按游戏的算法给手牌留出底下那一截。

## 检查过的

- `npm run determinism -- films/fanpan-arenas --seams --workers 4`：取样 27 帧，在新页面、乱序、顺序三种方式下逐像素一致。
- 七个镜头各出一张 1920×1080 静帧，逐张看过。
- 游戏里的检查（自动对局、低画质、手机横屏、减少动态效果）记在游戏仓库的说明里。

## 已知的不足

- 没有人实际玩过；城堡被攻破的画面没有看到（结算面板盖住了最后一帧）。
- 桌面端对面城堡的血量牌有一部分被游戏右上角的对局记录面板压住（游戏原来的场地也这样）。
- 手机横屏上个别场景的城堡顶部会被画面边缘裁掉一点（龙宫的骷髅礁、熔炉的锅炉、浮岛的风车塔）。
- 浮岛的整体亮度略高于另外几套；圣堂的细节密度比龙宫、熔炉低一些。
- `stage.js` 是照着游戏的数重搭的：游戏改了镜头、格子或后期，这里要手动跟着改。

## 来源与权利

- 棋子像素图是 CC0（原始出处 OpenDuelyst）。CC0 不含商标：片名和说明里不出现原游戏的名字与标志。
- 棋盘规格、镜头和后期链的数来自用户自己的《一步翻盘》项目。
- 画法参考 `cases/vendor/lemo-opuscar/styles/hd-2d/STYLE.md`（MIT，LemoLab），只取方法，代码自己写。
- 没有 AI 生成的画面；不出现任何现成游戏的角色和标志。
