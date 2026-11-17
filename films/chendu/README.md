# 晨渡

北冥风格路线 · WebGL 三渲二的 8 秒样片（两个镜头），由 A 路线模版建，是离屏出片 M3 的验收片（`docs/offscreen/plan-m3.md`）。同一部片两边都能出：

- A 路线页面：`index.html` + `main.js`（页面独有：查询参数、剪影检查、构图参考线、预演时间条）+ `rt-page.js`（three r170、GLSL 卡通材质）
- 离屏出片：`offscreen.mjs`（Node + Dawn，three r187、TSL）
- 两边共用：`story.js`（事件、字体核对、镜头、片名显示层、TEXTS）、`world.js`（`makeWorld(rt)`：色指定、材质、造型、水面、太阳；手写着色各给 GLSL 与 TSL 两份）、`shots/*.js`、`title.js`
- `tools/compare.mjs`：两边逐帧对拍（页面无损截图对离屏帧，msaa 0）

```sh
npm run film -- check films/chendu
npm run film -- stills films/chendu
node films/chendu/tools/compare.mjs --frames 0,40,71,72,90,96,120,150,191
npm run offscreen -- render films/chendu/offscreen.mjs --out films/chendu/out/offscreen.mp4 --frames 0:192 --size 1920x1080 --fps 24
```

与模版原样的差别：片名逐字按字形自己的墨迹外框居中（模版用 `textBaseline = 'middle'`，高低随机器的系统字体变，见 docs/offscreen/README.md 7.11）。`out/` 不提交。
