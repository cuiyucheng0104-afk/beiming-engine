---
description: "底板 PNG 多层视差合成"
tags: [positive]
covers: [plates-composite]
expected_outcome: "本 skill 触发：tsl/plates.js 的 createPlates（loadPlatesAsync/plate/cropPlate/cutoutPlane/glowSprite），摆位用 engine/stage/camera.js 的 placeOnScreen，底板不吃雾不描边。"
---

远景三层底板 PNG：远山、中景树林、近景芦苇，按深度摆开跟镜头做视差；芦苇用抠像面片（半透明的地方不写深度）；灯笼位置放一个加色辉光面片。
