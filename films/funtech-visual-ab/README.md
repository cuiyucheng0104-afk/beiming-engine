# FunTech 功能逐项对照

本目录为北冥 A 路线技术样片。左侧用北冥现有渲染工具或对应的基础做法，右侧用相同输入加一项功能。每个功能占 48 帧，同组素材、机位和事件时间由镜头输入决定。

- [源码与功能对照](SOURCE-COMPARISON.md) 覆盖 20 个仓库和 138 条功能记录，含固定上游提交、北冥源码和验证证据。
- [画面镜头表](shots/cases.json) 对应本目录 50 个对照。着色器入口与参数在 [materials.js](shots/materials.js)，16 个移植片元及对应提交路径在 [upstream.js](shots/upstream.js)。MIT 许可证随源码保留。
- [雨滴落水](../rain-ripple-ab)、[墨滴、烟尘与粒子聚字](../funtech-fx-ab)、[WebGPU 与 Worker](../funtech-platform-ab) 有各自的北冥镜头及运行入口。

画面使用程序化夹具。作品站交互由北冥时间轴和 Canvas 夹具复现，真实网站行为另有浏览器结果。角色样片用自有几何和程序姿态展示动作切换、表情、几何简化和取景。上游 GLB 的真实动作、变体与压缩效果由资产测试单独验证。视频平面样片使用可按帧采样的动态底板。帧间拖影回取固定的第 4 个历史帧，拖抹和流向使用录制路径形式的固定采样。

## 在北冥运行

在仓库根目录运行 `npm run serve`，打开 `/films/funtech-visual-ab/`。可拖动帧条，或在地址加 `?case=wave-radial` 直接停到指定镜头。

```sh
folder=films/funtech-visual-ab
node engine/render/video.mjs "$folder" --size 960x540 --workers 4 --chunk 48 --out "$folder/out/w4.mp4" --keep-segments
node engine/render/video.mjs "$folder" --size 960x540 --workers 1 --chunk 2400 --out "$folder/out/w1.mp4"
node tools/baseline/determinism.mjs "$folder" --seams --size 960x540 \
  --frames "$(node -p "require('./$folder/film.json').shots.map(s => s.in+24).join(',')")" \
  --out "$folder/out/determinism"
```

`--keep-segments` 保留一个视频文件对应一个功能。比较两次运行记录中的 `frameHashes.values` 可核对整片。确定性工具另外比较新页面、乱序、顺序三种取帧方式。媒体文件和机器生成的运行记录随 NAS 归档交付。
