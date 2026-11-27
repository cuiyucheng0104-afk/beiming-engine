# 渲染路径对照

两个北冥 A 路线镜头，每个镜头 48 帧。

- `webgpu-tsl` 使用同一立方体、相机及运动。左侧为 Three.js WebGL 法线材质，右侧为 WebGPU 原生后端与 TSL 节点材质。借鉴 [React-WebGL-Starter](https://github.com/FunTechInc/React-WebGL-Starter) 的 WebGPU 初始化与节点材质；初始化时断言使用 WebGPU，避免把回退截图当成验证结果。
- `worker` 左侧在主线程绘制固定指针轨迹，右侧在 Worker 用 OffscreenCanvas 画同一轨迹，把 ImageBitmap 交回主线程。借鉴 [react-three-offscreen](https://github.com/FunTechInc/react-three-offscreen) 的线程分工。两侧共用绘制函数，预期像素一致。上游的真实尺寸、指针事件和回退分支在独立浏览器夹具验证。

运行 `npm run serve` 后访问 `/films/funtech-platform-ab/`，用进度条取帧。需浏览器支持 GPU 与 Worker，成片依然用北冥逐帧记录。

```sh
folder=films/funtech-platform-ab
node engine/render/video.mjs "$folder" --size 960x540 --workers 4 --chunk 48 --out "$folder/out/w4.mp4" --keep-segments
node tools/baseline/determinism.mjs "$folder" --size 960x540 --seams --frames 0,24,48,72,95
```
