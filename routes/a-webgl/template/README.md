# {{TITLE}}

北冥风格路线 · WebGL 三渲二的作品，由 `routes/a-webgl/template` 复制而来。路线手册：[routes/a-webgl/README.md](../../routes/a-webgl/README.md)（「参考作品」一节逐条写了这个模版示范了哪条工艺）。

出片（在仓库根目录，按顺序；每道闸停下来请用户看，原话用 `npm run film -- review approve <闸> films/{{NAME}} --quote … --source … --reviewer …` 记）：

1. 字体子集（改了 `film.json` 的 `texts` 就重跑；缺字直接失败）：`node tools/fonts/subset.mjs films/{{NAME}}`
2. 只读检查：`npm run film -- check films/{{NAME}}`
3. 风格关键帧（look 闸）：`npm run film -- stills films/{{NAME}}`；自查构图与剪影再加 `--query guides=1`、`--query sil=1` 各出一组
4. 动态预演（animatic 闸）：`npm run film -- animatic films/{{NAME}}`
5. 终渲（声音 → 逐帧 → 封装 → 网页版 → 机器 QA）：`npm run film -- build films/{{NAME}} --final`；不加 `--final` 是不查闸门的工作版

改哪里：`film.json`（时长、镜头表、事件、文字、字体、画风预设）→ `world.js`（色指定、材质与皴、主体、水面、太阳）→ `shots/*.js`（每镜的机位、底板、运动）→ `main.js`（片名与副标题的版式和节奏）→ `sound.py`（声音）。`out/` 不提交；`fonts/`、`review/` 随作品提交。
