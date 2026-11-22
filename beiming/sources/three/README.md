# sources/three/：three 帧源

照帧源接口契约出帧的 WebGL 帧源，渲染库是 0.187.0 的 three。帧源是渲染器加宿主的一对：这里是渲染器和共用的能力声明、计划；宿主在 `beiming/host/page/`，对上层的接口（`caps`、`open`，会话的 `manifest`、`render`、`query`、`close`）在它的 node 一侧。

| 文件 | 在哪跑 | 管什么 |
|---|---|---|
| `caps.mjs` | 页面、node | 能力声明 `caps(library)`，帧源定的默认值都在这里（子帧采样数 8、两个档位的采样数和缩放）；提供了卡才声明 `cards-data` 模式 |
| `plan.mjs` | 页面、node | `planOpen`：装不装得了（宿主和作者模式、种子、卡实例对锁文件、资产、叠加层）；`planRender`：输出交不交得出、快门、子帧相位、尺寸；`parseShutterArgs`：`--shutter <度> --samples <子帧数>` 换成 `RenderOpts.shutter`。快门角也认兼容写法 `angle` |
| `source.js` | 页面 | 渲染器 `createThreeSource({ THREE, host })`，只有它碰 WebGL；`averageDisplayFrames` 纯函数 |

## 宿主交进来的服务

| 服务 | 做什么 |
|---|---|
| `host.load(shot, { THREE, renderer })` | 装载镜头（入口文件调一次 `build`，或跑「卡加数据」固定装载脚本），交回 `{ object, size, post? }` |
| `host.apply(loaded, f, sub)` | 把 `(f, sub)` 的状态写进场景 |
| `host.measure(loaded, f, facts)` | 量元数据；`facts.visible` 是渲染器数出的可见比例 |
| `host.now()` | 单调时钟，毫秒，只进 `timing` |

渲染器交回读回的各层和元数据；写层文件、交层引用是宿主在 node 一侧做。

## 怎么出一帧

- 快门窗口从帧起点打开 `[f, f + 快门角 ÷ 360)`，子帧在窗口里居中分层；180 度 8 个子帧的拖影中点在 f + 0.25（`s4.test.mjs` 对拍 Blender START 读数）。
- 颜色层（04 §3.1）：每个子帧只渲后期链之前的场景，进 32 位浮点目标，在线性光里逐像素平均；不过显示变换，不截到 `[0, 1]`。显示参考、没有 HDR 目标的帧用 `averageDisplayFrames` 把 8 位 sRGB 先线性化再平均。
- 后期链：`post` 是全屏通道网格（材质带 `uniforms.tInput`），对平均后的结果按次序只跑一次，两个浮点目标来回倒。声明了 `uniforms.tDepth` 的通道拿到 `sub = 0` 的深度（R 平面深度米，A 为 0 表示没打到）。后期类卡的 `Handle.object` 就是这张网格，宿主放进 `post`、不放进场景（这一对里的约定）。`stats.tris` 只数场景那一遍。
- 辅助层：`sub = 0`（计划里的 `auxSub`）、针孔、像素中心，不抗锯齿，不过后期链。`depth` 平面深度米，`objectId` 叶子实体编号，`normal` 相机空间着色法线、背面翻向相机。没打到：编号 0、深度 1e10、法线 `(0, 0, 0)`。不在 `entities` 里的网格编号 0。
- 辅助材质只画网格：有看得见的点、线、精灵时要辅助层（或后期要深度）报 `contract.unsupported-object`。
- 可见比例（元数据契约 5.3）：四分之一分辨率编号层上，带角色（`hero`、`mustSee`）的实体合渲像素数除以单独渲的像素数（不超过 1，单独渲为 0 记 0）；没出像素、没有带角色的实体、有点线精灵时写 `null`。
- 清屏：每一遍自己定 `(0, 0, 0, 0)`，渲完还原。镜头设了背景色时颜色层背景是背景色、透明度 1。
- 取值次序：`RenderOpts` → 锁文件 → 镜头条目 → 能力声明。条目带 `renderer` 对象时出帧用它里面的 `source`、`host`、`mode`、`entry`；元数据 `source.id` 填顶层的，`source.renderer` 填 `three`。
- 没有锁文件：种子必须写在条目里；条目的 `cards`、`assets` 或全片的 `assets`、`overlays` 不空报 `env.lock-required`。有锁文件时逐个卡实例（叠加层先展开）核对提供、主版本、锁里的版本和哈希、实现落点、数据卡的轨道（只有 `tracks.camera`），不对或带了资产报 `contract.unsupported-input`。先后：`contract.unsupported-mode` → 没锁文件 → 这一条。
- 参数出值域报 `usage.bad-argument`；快门角 0 配多个子帧报 `contract.shutter-conflict`。

## 边界

- `motion` 交不出；场景查询不答；每像素只取 1 个样本，多了报 `contract.unsupported-option`。
- 作者模式：默认只有 `native-code`；`startSource({ cards })` 提供了卡才多 `cards-data`。
- 没有场景包：实体编号按名字字节序从 1 起，0 表示没打到；类别：点云 `particles`，名下还有实体的 `assembly`，其余 `part`。
- 资产没接；叠加层要的卡还没有，带锁文件也报 `contract.unsupported-input`。
- 32 位浮点目标在 Metal、Vulkan、软件渲染上都量过（帧源接口契约第 6 节）。

测试：`node --test 'beiming/sources/three/*.test.mjs'`。`source.test.mjs` 不起浏览器；`render.test.mjs`、`s4.test.mjs` 起无头浏览器实渲（起不了时跳过）：清屏不残留、没打到的值、层引用；子帧累积和后期先后、拖影中点、辅助层取 `sub = 0`。「卡加数据」、后期链和可见比例另见 `beiming/cards/m1a-cards.test.mjs`。
