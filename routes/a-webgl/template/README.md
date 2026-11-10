# {{TITLE}}

北冥风格路线 · WebGL 三渲二的作品，由 `routes/a-webgl/template` 复制而来。路线手册：[routes/a-webgl/README.md](../../routes/a-webgl/README.md)（「参考作品」一节逐条写了这个模版示范了哪条工艺）。

出片（在仓库根目录，按顺序）：

1. 字体子集（改了 `film.json` 的 `texts` 就重跑；缺字直接失败）：`node tools/fonts/subset.mjs films/{{NAME}}`
2. 钥匙帧（look 闸给用户看这几张）：`node engine/render/still.mjs films/{{NAME}} 1.5 4.25 6.5 --size 1920x1080 --out films/{{NAME}}/out/look`
3. 自查构图与剪影：`node engine/render/still.mjs films/{{NAME}} 1.5 6.5 --size 1920x1080 --query guides=1 --out films/{{NAME}}/out/qa`（再换 `--query sil=1` 出一组）
4. 统一出片（声音 → 逐帧 → 封装 → QA）：`npm run film -- build films/{{NAME}}`

改哪里：`film.json`（时长、镜头表、事件、文字、画风预设）→ `world.js`（色指定、材质、主体、水面、太阳）→ `shots/*.js`（每镜的机位、底板、运动）→ `main.js`（片名与字幕版式）→ `sound.py`（声音）。`out/` 不提交。
