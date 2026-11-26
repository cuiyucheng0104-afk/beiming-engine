# 雨落成纹

北冥 A 路线的雨滴工作样片。左侧复用 A 路线模版水面材质，并以一条衰减细环表现触水。右侧使用同一底图、雨滴与细环，额外使用 use-shader-fx 的波纹片元着色器对纹理盖印，再用波纹图做折射与亮暗合成。上游着色器见 [原始文件](https://github.com/FunTechInc/use-shader-fx/blob/338e63427310a6b13947f68c5863e4cf4bbb62f1/packages/use-shader-fx/src/fxs/simulations/useRipple/shader/main.frag)，版权与许可见 [USE-SHADER-FX-LICENSE.txt](USE-SHADER-FX-LICENSE.txt)。

全长 120 帧、24 fps，雨滴触水帧来自 `film.json`。每个波纹的位置、尺寸和透明度由该帧的事件年龄直接计算。画面由程序生成，含 AI 辅助编写的画面代码。

在仓库根目录运行 `npm run serve -- --port 8080`，打开 `http://127.0.0.1:8080/films/rain-ripple-ab/`。预览可暂停和拖动进度条。

```sh
npm run determinism -- films/rain-ripple-ab --seams --workers 4 --frames 0,14,34,58,82,97,119 --out films/rain-ripple-ab/out/determinism
node engine/render/video.mjs films/rain-ripple-ab --chunk 30 --workers 4 --out films/rain-ripple-ab/out/rain-ripple-ab.mp4
```
