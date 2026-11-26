# 分层风格化

`composeLayerLookFilm` 为指定镜头添加一道显示空间工序，其余交付参数沿用 `deliver`。调用方通过`renderFrame`提供分层风格化能力，并管理该回调使用的渲染资源。只想走常规交付时直接调用 `deliver`。

```js
import { composeLayerLookFilm } from './index.mjs';

await composeLayerLookFilm({
  ...deliveryOptions,
  frames: {
    ...deliveryOptions.frames,
    s01: {
      pattern: 'frames/s01/color.%06d.png',
      kind: 'png',
      transfer: 'srgb',
      auxiliaryLayers: {
        depth: ['frames/s01/depth.000000.png'],
        objectId: ['frames/s01/object-id.000000.png'],
        normal: ['frames/s01/normal.000000.png'],
        depthUnitM: 0.001,
      },
    },
  },
  layerLook: { shotId: 's01', renderFrame },
});
```

- 目标镜头须声明 `colorRef: 'display'`。输入颜色为已编码的 8 位 sRGB PNG。三个辅助层路径数组按镜头局部帧号排列，各自与镜头帧数相等。深度与编号用 16 位灰度 PNG。法线用 RGB(A)8 PNG，三分量表示相机空间法线，将 `[-1, 1]` 线性映射到 `[0, 255]`。四层都需非隔行，尺寸一致且等于影片输出尺寸。
- `renderFrame({ shotId, frame, time, size, depthUnitM, layers })` 逐帧接收四层 PNG 的字节，键为 `color`、`depth`、`objectId`、`normal`。`frame` 从镜头局部第 0 帧开始，`time` 是局部秒数。`depthUnitM` 是每个深度码值代表的米数。返回自上而下排列、连续交错的 sRGB RGB8 `Uint8Array`，也可返回 Promise。
- 合成器在首帧前检查每张输入 PNG 的文件、头格式和尺寸，渲染器负责解码 PNG 像素。渲染后的帧先写到独立暂存目录，再由 `deliver` 编码。硬切、透明叠加、收尾与交付规格沿用常规交付。渲染或交付出错时删除暂存帧。
- HTTP 交付和片子描述没有自动启用 X8 的选项。全片的 `delivery.layers` 仍是帧源落盘通道，由调用方把 X8 需要的 PNG 明确交给该镜头。

入库样本来自 `tests/offscreen/fixtures/layers-scene.mjs` 的合成输入。测试用真正的 `engine/look/layers.js` 渲染并调用合成入口，把风格化镜头放在硬切之后，核对母版的解码像素与六件套。像素哈希取解码后的 RGB8，浏览器和软件后端写在样本目录的 `golden.json` 中。登记过的栈严格匹配入库哈希。其他栈也须两次重渲逐位一致，并且与入库样本的平均通道误差不超过 0.5 码值。

```sh
BEIMING_X8_REQUIRE_RENDER=1 node --test tests/offscreen/x8-layer-look.test.mjs
```
