---
description: "外部渲染器分层图合成北冥画风"
tags: [positive]
covers: [layer-look]
expected_outcome: "本 skill 触发：tsl/layers.js 的 loadLayers + createLayerLook（view/split/outline/toon/kuwahara/paper 参数），不依赖 engine/native/。"
---

光追工作站导出了分层图（颜色、16 位深度、物体编号、视空间法线各一张 PNG），把它合成为北冥画风：保色相三档色阶 + 墨线 + Kuwahara + 纸纹，左右分屏对比原始颜色。
