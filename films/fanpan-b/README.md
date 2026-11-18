# 林间擂台（B 版 · 北冥原生 · BNE）

《一步翻盘》对战盘的风格样张，和 [C 版](../fanpan-c/README.md) 摆的是同一个场面：同一份调度、同一份几何、同一份像素贴图，差别只在渲染。6 秒循环（144 帧，24 fps，1920×1080），没有声音。

状态：只出了风格关键帧，look、animatic、final 三道闸都没有用户认可。

## 和 C 版的差别

- 场景不在页面里画，而是由资产桥把 `diorama.js` 导成两个 GLB：`arena.glb`（会投影的部分）和 `arena-soft.glb`（不投影的部分：发光体、草丛、旗）。原生运行时按整个模型开关投影，所以要拆成两份
- 灯用真实单位（太阳按勒克斯、小灯按流明），级联阴影，景深是镜头自己的（焦距 + 光圈），没有另加屏幕上的移轴
- 血量牌、脚下的圈、战力牌是另外叠的小卡片（黑底 + 贴图自发光），图由 `marks.mjs` 从 `px.js` 导出
- 光柱是三片朝着镜头的半透明薄片。试过体积雾，在这个场景里看不到光束，只会把画面整体压暗，所以只留了一层很薄的雾

## 文件

| 文件 | 管什么 |
|---|---|
| `film.tsx` | 这一版的画面编排：镜头、灯、模型、棋子卡片、光柱、浮尘、后期。调画面改开头的 `LOOK` |
| `film.json` | 作品描述：尺寸、帧数、素材清单（`native.images`、`native.models`）、署名 |
| `layout.js`、`px.js`、`diorama.js` | C 版同名文件的原样拷贝，不在这边单独改 |
| `marks.mjs` | 把血量牌、圈、战力牌、光柱渐变导成 `marks/*.png` |
| `units/` | 十条棋子待机序列帧（CC0） |
| `media/` | 准备好的素材（生成物） |

## 出图

在仓库根目录，先设好原生运行时的路径（`export RAEA_BIN=<可执行文件>`）：

```sh
node films/fanpan-b/marks.mjs
node engine/native/prepare.mjs films/fanpan-b
node engine/render/native.mjs films/fanpan-b --check-only
node engine/render/native.mjs films/fanpan-b --at 0,72,143 --max-gpu-util 40
```

静帧在 `films/fanpan-b/out/<run-id>/stills/f<帧号>.png`，日志在同一个运行目录的 `render.log`。桌面上开着别的吃显卡的程序时要带 `--max-gpu-util 40`，默认超过 10% 就拒绝渲染。

## 踩过的坑

- 两个模型本来是一个场景的两半，互相穿插，`<Model>` 都要写 `allowOverlap`，否则穿模检查报错
- 贴图写成 `{ path }` 时必须带 `sampler`，否则报错；不需要像素采样就直接传 `staticFile(...)`
- 资产桥会把「不受光且带贴图」的材质变成白色自发光，所以城门上的血量牌在模型里是一块白板，靠前面叠的那张卡片显示
- 一次渲多帧（`--at 0,72,143`）和单独渲一帧（`--at 72`），同一个帧号出来的图不完全一样：差别集中在棋子的待机姿势上，机位和光一致。同一条命令重复跑，结果是一致的。原因还没查清；要拿某一帧对比就单独渲它
- 不受光（`unlit`）的材质不吃曝光，在这个曝光下发灰；要亮的东西用「黑底 + 贴图自发光」

## 来源与权利

- 原生运行时是第三方 FSL-1.1-ALv2 软件，只作内部制作层：不分发、不复制源码、不做成对外的产品或服务
- 画法参考 `cases/vendor/lemo-opuscar/styles/hd-2d/STYLE.md`（MIT，LemoLab），只取方法
- 棋子像素图是 CC0（原始出处 OpenDuelyst），不出现原游戏的名字与标志；没有 AI 生成的画面
