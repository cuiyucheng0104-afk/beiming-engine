# host/page/：页面宿主

起无头、静音的浏览器，在页面里装载镜头、驱动帧源出帧，把读回的东西落盘。

| 文件 | 在哪跑 | 管什么 |
|---|---|---|
| `host.mjs` | node | `openHost({ filmPath, shotId, tier })`：起本机静态服务和浏览器，交回页面运行时的各个方法；`writeFrame(dir, result)`：把一次 `render` 落盘 |
| `runtime.js` | 页面 | 搭 `ctx`、调一次 `build`、驱动 `state`、量元数据、算状态摘要，并记下每次调用实际做了什么 |
| `measure.js` | 页面、node | 量元数据的算式：投影到屏幕、包围盒、屏占、平面深度范围、画面统计 |
| `clock.js` | 页面 | 量耗时的单调时钟。全链路只有这一处读时钟，读数只进元数据的 `timing` |

落盘的一帧：

```
<目录>/color.f32      RGBA，32 位浮点，小端，行序从上到下，场景线性
<目录>/depth.f32      一个分量，米
<目录>/objectId.u32   一个分量，32 位无符号整数
<目录>/normal.f32     三个分量
<目录>/meta.json      每帧元数据
<目录>/preview.png    给人看的 8 位预览：截到 [0, 1] 再做 sRGB 编码，不是片子描述里的显示变换
```

现在的边界：只驱动 three 帧源；不接卡、事件表、叠加层、资产、锚点和数据轨道（`ctx` 里这几项是空的或一用就报错）；镜头种子必须写在片子描述里；`visible` 不算，写 `null`。

元数据量的是帧源最后一次叫宿主写进场景的那个状态：`shotFrame`、`frame`、`sub` 都照那一次记。状态摘要含相机矩阵、每个对象的世界矩阵、可见性、顶点位置和材质的基本颜色，不含自定义着色器的参数和贴图。

浏览器启动参数沿用旧渲染器的 `chromeArgs()`，另加 `--mute-audio`。静态服务只绑本机地址，只放行 `beiming/` 和 three 的构建目录。

测试：`node --test 'beiming/host/page/*.test.mjs'`
