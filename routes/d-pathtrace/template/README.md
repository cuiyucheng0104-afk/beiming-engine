# {{TITLE}}

北冥光追 · 物理路径追踪（D 路线）作品，由 `routes/d-pathtrace/template` 生成。路线手册：[routes/d-pathtrace/README.md](/routes/d-pathtrace/README.md)。

出片（在仓库根目录按顺序执行；每道闸停下来请用户看，原话用 `npm run film -- review approve <闸> films/{{NAME}} --quote … --source … --reviewer …` 记录）：

1. 只读检查：`npm run film -- check films/{{NAME}}`
2. 风格关键帧（look 闸）：`npm run film -- stills films/{{NAME}}`
3. 动态预演（animatic 闸，半分辨率 4 SPP）：`npm run film -- animatic films/{{NAME}}`
4. 工作版整片 / 终渲：`npm run film -- build films/{{NAME}}`（终渲加 `--final`，须先过前两道闸）

改哪里：`film.json`（时长、整数帧镜头表与事件表、`pathtrace` 采样与 `shotSpp`）→ `scene.ts`（拉丝钨钢几何、WGSL 材质、面光源、机位与 `textsAt` 安全区铭牌）→ `mix.py`（48 kHz 立体声音轨与事件起音自检）→ `TREATMENT.md`（导演阐述）。`out/` 不提交；`review/` 随作品提交。
