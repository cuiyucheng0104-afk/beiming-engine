# 鹏 / 羽化模块交接

限定修改范围：`src/peng.js`、`src/peng-feathers.js`、`lab/peng-film.js`、`tools/test_peng/`。
原 `src/kun.js`、`src/toon.js`、`src/kun_peng.js`、`engine/stage/outline.js` 的 SHA-256 与开工前一致。
鹏没有引用 E 组 `toon_peng.js`，没有新建 palette。全部材质来自原 `makeToonMaterial`，共享原 `TOON_SHARED`；三档阈值沿用 `TOON_PRESETS.kun`（0.53 / 0.17）。

## API

```js
import { createPeng, createFeatherSwarm } from './src/peng.js';

const peng = createPeng({ lod: 1 });
// { group, setPose, fitShadow, outlineMeshes, length, wingspan }
// +X 头，+Y 上，±Z 翼；中性展开翼展 600，含扇尾体长约 359.35。
peng.setPose(filmTime - 455, { spread: 1, flap: 0.4, flight: 1 });
peng.fitShadow(keyDirectionalLight, { size: 2048 });

const feathers = createFeatherSwarm({ count: 200, seed: 20261105 });
// { group, setPose }
feathers.setPose(kunPoseTime, { amount: 1, burst: 0.55 });
```

- `lod` 夹在 0.15–1；低 LOD 保留全部十一枚初级飞羽与十三枚扇尾。
- `spread`：0 上举收拢，1 展翼。`flap`：0 滑翔，1 完整慢拍，周期 5.5 秒。`flight`：0 安定，1 俯仰、微升沉和收爪。参数均为 0–1。
- 鹏在内部 rig 上动画，24fps 采样；不覆盖外部 `group.position/rotation/scale`。世界轨迹和持续升高由主 world 控制。
- 羽群根点取原鲲背部，采用原鲲 `pitchWave` 默认参数。应与鲲同级、共用世界变换，传入和鲲完全相同的姿态时钟。若调用方改过鲲的波幅/频率，贴附阶段需额外匹配，当前 API 不接收这些自定义值。
- 羽群 `amount=0` 隐藏，逐渐增加会把窄绿叶展开为原色板羽片；`burst=0` 贴附，1 散出。中间 0.5–0.6 加密遮挡，切换后降低 amount。它是有厚度的空间羽群，不能替代完全不透明的全屏遮罩；主镜头需选择遮挡最密的一帧。
- 所有造型/羽群都是封闭实体或实体实例；无透明羽片，无只在 beauty 里变形的着色器。通过 `bindToon` 与 `wireOutlines` 绑定，阴影、ID 和颜色使用同一几何及层级变换。
- 模型不写全局 uniform；主 world 继续负责原 look C、纸纹、`TOON_SHARED.uInkTime`。测试页才设置自己的 ink 时钟。

## 主 world 镜头建议

以下为原 16° 相机朝 −Z、比例 1920×1040、模型 scale=1，depth 从模型原点量起。旋转按 Three 默认 XYZ。

| 用途 | rotation | depth | 姿态 |
| --- | --- | --- | --- |
| 当前羽层近景 | `.28, Math.PI-.4, -.08` | 950 | `flap=.25–.4`，允许尾/翼局部出画 |
| 当前朝向完整展示 | 同上 | 1200–1350 | `spread=1, flap<=.4` |
| 双翼全景推荐 | `.32, Math.PI-.95, -.08` | 1300–1400 | `spread=1, flap=.25–.4` |
| 双翼完整慢拍 | 同上 | 1700–1800 | `spread=1, flap=1` |
| 当前朝向完整慢拍 | `.28, Math.PI-.4, -.08` | 1800–1900 | `spread=1, flap=1` |

距离根据一个完整周期的 33 个姿态、每个网格/实例局部包围盒投影计算，含约 15% 画幅余量。当前朝向在 flap=.4 / 1 的保守最小 depth 分别为 1157 / 1748；推荐双翼朝向为 1197 / 1622。若 scale 改变，depth 同比缩放；主 world 的运镜位移另计。

## 独立测试

```sh
cd @@CASE_ROOT@@
node tools/test_peng/run.mjs
node tools/test_peng/run.mjs --render
# 单张；另加 --poses 会输出收翼、上举和下扑三图
node tools/test_peng/run.mjs --render --view hero --time 471
```

已有服务器可直接打开：`/index.html?test=peng-film&view=hero&t=471`。
支持 `world / hero / wide / head / feather / underside / swarm / film`；`film` 为 455–490 秒确定性升空示范。
页面默认停帧，可调用 `window.render(471)` 或 `window.pengLab.render(471, 'feather')`。不会启动 RAF 或后台渲染循环。

已在本机 Apple M5 Pro / ANGLE Metal 实测，单浏览器、1440×900 静帧，未访问 5090。

- LOD 1：276,528 三角形、98 网格；LOD .25：152,616 三角形。200 片羽群另计 76,800 三角形。
- 841 个姿态：有限矩阵、24fps 采样、任意顺序 seek 可重复、外部变换保留。
- 12 组 spread/flap/flight 端点组合；羽毛网格每条边恰有两面。
- 变换后模型被阴影视锥完整包含；原共享 uniform、三档阈值、投影/描边标记校验通过。
- 羽群同种子一致、不同种子不同、反向 seek 一致、count=0 / amount=0 正常。
- 实际 WebGL beauty、投影及屏幕空间描边通过；19 个 shader program 可运行，无捕获到的 console error。
- 已目视检查近景羽层、头部、上下翼面、收翼/上举/下扑：未见破面或从背面透空。没有做 840 帧逐帧像素级碰撞证明。

图片均在本目录：`peng-world.png`、`peng-hero.png`、`peng-wide.png`、`peng-head.png`、`peng-feather.png`、`peng-underside.png`、`peng-furled.png`、`peng-upstroke.png`、`peng-downstroke.png`、`peng-swarm.png`。测试数据见 `peng-report.json`。
