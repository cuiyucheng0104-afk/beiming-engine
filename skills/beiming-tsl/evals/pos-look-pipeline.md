---
description: "新作品接 A 风格整条 WebGPU 后期管线"
tags: [positive]
covers: [look-pipeline]
expected_outcome: "本 skill 触发：查 subject-routing 的 look-pipeline，照 films/chendu/offscreen.mjs 的 createFilm().work({ shots, look, draw }) 接法组装 createLook，组合顺序不改。"
---

《远帆》要用离屏 WebGPU 出片（A 风格）：主场景 + 屏幕空间墨线 + 雾 + bloom + Kuwahara + 纸纹整条后期都要，镜头的 look 参数随时间推。帮我把管线接起来。
