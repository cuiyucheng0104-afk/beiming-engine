---
description: "控制哪些物体描边、哪些只挡线"
tags: [positive]
covers: [id-pass]
expected_outcome: "本 skill 触发：用 userData 开关（outline/outlineWidth/outlineGroup/outlineOccluder='soft'|'own'/noId），不直接调 createIdPass。"
---

主角和斗笠要描边，蓑衣和斗笠算一组别在接缝处出线；雨丝不描也不挡线；船帆半透明，用自己的 alpha 削减后面的线就行。
