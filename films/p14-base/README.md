# 浮标（北冥原生 · BNE）

- 改画面：`film.tsx`（镜头 `SHOTS`、站位、字幕）；改颜色：`palette.json`；改道具：`prop.js`；改声音：`sound.py`；素材清单与片长尺寸：`film.json`。
- 准备素材：`PYTHON=<带 numpy/scipy/soundfile/numba 的 python> node engine/native/prepare.mjs films/p14-base`（在仓库根目录运行）。
- 出片：`RAEA_BIN=<原生运行时可执行文件> node engine/render/native.mjs films/p14-base`，成片在 `films/p14-base/out/p14-base.mp4`；只看几帧加 `--at 0,36,71`。
- 加一段别的作品当贴图：在 `film.json` 的 `sequences` 里写 `{ "to": "screen.png", "page": "../..", "from": 0, "until": 2, "fps": 12, "size": [960, 520], "cell": [480, 260] }`，在 `film.tsx` 里用 `<SequencePlane>`，见 `routes/b-native/README.md`。
