# 渡

北冥风格路线 · WebGL 三渲二的 4 秒小样，也是离屏出片 M2 T5 的验收片（`docs/offscreen/plan-m2.md`）。阐述见 [TREATMENT.md](TREATMENT.md)。

- `scene.mjs`：唯一的场景，THREE 由调用方注入，A 路线页面（three r170）与离屏出片（r187）共用
- `shots/s1.js` + `main.js` + `index.html`：A 路线页面（正片走这边）
- `offscreen.mjs`：离屏出片入口（对照版本）
- `tools/compare.mjs`：两边逐帧对拍（msaa 0，无损像素，M1 质量门）

```sh
npm run film -- check films/du
npm run film -- stills films/du --frames 12,40,66,90               # look 闸
node films/du/tools/compare.mjs --frames 12,40,66,90                # A 路线对离屏
npm run offscreen -- render films/du/offscreen.mjs --out films/du/out/offscreen.mp4 --frames 0:96 --size 1920x1080
```

声音见 `sound.py`（TREATMENT §13）。`out/` 不提交。
